// The hub Worker's HTTP surface: the shared HubApi
// (packages/contracts/src/hubApi.ts) served with its handlers, its two
// auth tiers, the rate limiter and open CORS. createWorker(deps) is the
// seam the tests stub Clerk and the Cloudflare API through, and
// index.ts wires the real ones.
//
// Every route sits behind a per-IP rate limiter (rateLimit below). It
// bounds what one caller can make the Worker do downstream (D1, the
// Durable Objects, Clerk). It cannot stop the Worker invocation itself
// from being billed, only a WAF rule at the zone can, see README.md
// (Abuse limits).
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  DeviceAuth,
  HubAccountFullError,
  HubApi,
  HubDevice,
  HubDeviceEnrolledElsewhereError,
  HubLogin,
  HubTicketMalformedError,
  HubTicketSigningUnconfiguredError,
  HubTunnelUnconfiguredError,
  HubUnavailableError,
  HubUnknownDeviceError,
  HubUpgradeRequiredError,
  HUB_PROTOCOL_FLOOR,
  LoginAuth,
  PROTOCOL_HEADER,
  ProtocolFloor,
} from "@shigomori/contracts/hubApi";
import {
  HubCredentialRejectedError,
  HubDeviceRevokedError,
  HubLoginRejectedError,
  HubUpdateRequiredError,
} from "@shigomori/contracts/errors";
import {
  type DeviceInfoWire,
  MAX_ACCOUNT_DEVICES,
} from "@shigomori/contracts/hubProtocol";
import { randomBase64url, sha256Hex } from "./crypto.ts";
import { type Env, WaitUntil, WorkerEnv } from "./env.ts";
import { CONNECT_RANDOM_PARAM, type EnrollOutcome } from "./hubObject.ts";
import * as Registry from "./Registry.ts";
import {
  DEVICE_CREDENTIAL_PREFIX,
  buildTicket,
  parseTicket,
} from "./ticket.ts";
import { provisionTunnel, teardownTunnel, tunnelEnvOf } from "./tunnel.ts";

export interface HubDeps {
  // Resolves the enroll bearer (a Clerk session or OAuth access token)
  // to the owning account, or null when it does not verify; throws when
  // it could not be checked.
  verifyLogin(token: string, env: Env): Promise<{ accountId: string } | null>;
  // The fetch the Cloudflare tunnel API is called through. Defaults to
  // the global fetch.
  cfFetch?: typeof fetch;
}

// Structurally compatible with ExportedHandler<Env>, with fetch and
// the context required.
export interface HubWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

// ---- Services ----

class LoginVerifier extends Context.Service<
  LoginVerifier,
  (token: string) => Promise<{ accountId: string } | null>
>()("sm/hub/LoginVerifier") {}

class CfFetch extends Context.Service<CfFetch, typeof fetch>()(
  "sm/hub/CfFetch",
) {}

// The account's Durable Object.
const accountHub = (env: Env, accountId: string) =>
  env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(accountId));

// The refusal for a failed step behind a route, as a catchTags handler,
// its cause logged: the response says only which step.
const unavailable =
  (operation: HubUnavailableError["operation"]) => (cause: unknown) =>
    Effect.logError(`hub: ${operation} failed`, cause).pipe(
      Effect.andThen(Effect.fail(new HubUnavailableError({ operation }))),
    );

// ---- Auth tiers ----

const loginAuth = Layer.effect(
  LoginAuth,
  Effect.gen(function* () {
    const verify = yield* LoginVerifier;
    return LoginAuth.of({
      bearer: (effect, { credential }) =>
        Effect.gen(function* () {
          const token = Redacted.value(credential);
          const login =
            token === ""
              ? null
              : yield* Effect.tryPromise(() => verify(token)).pipe(
                  Effect.catchTags({ UnknownError: unavailable("enroll") }),
                );
          if (login === null) return yield* new HubLoginRejectedError();
          return yield* Effect.provideService(effect, HubLogin, login);
        }),
    });
  }),
);

const deviceAuth = Layer.effect(
  DeviceAuth,
  Effect.gen(function* () {
    const registry = yield* Registry.Registry;
    return DeviceAuth.of({
      bearer: (effect, { credential }) =>
        Effect.gen(function* () {
          const token = Redacted.value(credential);
          // The prefix keeps Clerk tokens and credentials from ever
          // reaching the wrong tier.
          if (!token.startsWith(DEVICE_CREDENTIAL_PREFIX)) {
            return yield* new HubCredentialRejectedError();
          }
          const hash = yield* Effect.promise(() => sha256Hex(token));
          const device = yield* registry.byCredentialHash(hash);
          if (device === null) {
            // A revoked credential (tombstoned by the revoke) gets the
            // refusal the app signs out on, which is how a device that
            // was offline at the revoke learns of it. Anything else is
            // the plain refusal.
            return yield* (yield* registry.isRevoked(hash))
              ? new HubDeviceRevokedError()
              : new HubCredentialRejectedError();
          }
          return yield* Effect.provideService(effect, HubDevice, {
            deviceId: device.device_id,
            accountId: device.account_id,
            credentialHash: hash,
          });
        }).pipe(Effect.catchTags({ RegistryError: unavailable("credential") })),
    });
  }),
);

// ---- The version floor ----

// A build that names no protocol, or one below the floor, gets the
// refusal before any credential is looked at.
const protocolFloor = Layer.succeed(ProtocolFloor, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const version = Number(request.headers[PROTOCOL_HEADER]);
    if (!Number.isInteger(version) || version < HUB_PROTOCOL_FLOOR) {
      return yield* new HubUpdateRequiredError({
        floor: HUB_PROTOCOL_FLOOR,
        error:
          "This version of Shigoto no Mori is too old for the device hub. Update it to connect.",
      });
    }
    return yield* effect;
  }),
);

// ---- Handlers ----

// One row as the API reports it, for the list and the enroll response
// alike, so the two cannot disagree about a device.
function toDeviceInfo(
  row: Omit<
    Registry.DeviceRow,
    "account_id" | "credential_hash" | "public_key"
  >,
  online: ReadonlySet<string>,
): DeviceInfoWire {
  return {
    deviceId: row.device_id,
    name: row.name,
    platform: row.platform,
    // The column holds whatever the device sent and goes out as is:
    // each reader maps it to the catalog it knows (DeviceInfoSchema).
    icon: row.icon,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    online: online.has(row.device_id),
  };
}

const handlers = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const registry = yield* Registry.Registry;
  const cfFetch = yield* CfFetch;

  // Who is online in the account, from its hub object. Presence is
  // advisory in a device list, so a hub object hiccup reads as every
  // device offline rather than failing the list.
  const presenceOrNone = (accountId: string) =>
    Effect.tryPromise(() => accountHub(env, accountId).online()).pipe(
      Effect.map((online): ReadonlySet<string> => new Set(online)),
      Effect.catch((cause) =>
        Effect.logWarning("hub: presence unread", cause).pipe(
          Effect.as(new Set<string>() as ReadonlySet<string>),
        ),
      ),
    );

  // A removed device's tunnel, best-effort, finishing after the
  // response.
  const tearDownTunnel = Effect.fn("tearDownTunnel")(function* (
    accountId: string,
    deviceId: string,
  ) {
    const cf = tunnelEnvOf(env);
    if (cf === null) return;
    const waitUntil = yield* WaitUntil;
    waitUntil(teardownTunnel(cf, cfFetch, accountId, deviceId));
  });

  const enrollment = HttpApiBuilder.group(HubApi, "enrollment", (handle) =>
    handle.handle("enroll", ({ payload }) =>
      Effect.gen(function* () {
        const { accountId } = yield* HubLogin;
        const { deviceId, name, platform, icon, publicKey } = payload;
        // Enrolling again rotates the credential and the key: exactly
        // one credential per device is valid at any time, because only
        // one hash is stored, and the roster hands peers the key the
        // device enrolled with last. The account's object admits the device against the
        // cap and writes it in one step (DeviceHub.enroll).
        const credential = DEVICE_CREDENTIAL_PREFIX + randomBase64url(32);
        const credentialHash = yield* Effect.promise(() =>
          sha256Hex(credential),
        );
        const outcome = yield* Effect.tryPromise(
          async (): Promise<EnrollOutcome> =>
            await accountHub(env, accountId).enroll({
              deviceId,
              accountId,
              name,
              platform,
              icon,
              publicKey,
              credentialHash,
            }),
        );
        if (outcome.status === "enrolled-elsewhere") {
          return yield* new HubDeviceEnrolledElsewhereError();
        }
        if (outcome.status === "account-full") {
          return yield* new HubAccountFullError({
            limit: MAX_ACCOUNT_DEVICES,
          });
        }
        if (outcome.evicted !== null) {
          yield* tearDownTunnel(accountId, outcome.evicted);
        }
        return {
          credential,
          device: toDeviceInfo(
            {
              device_id: deviceId,
              name,
              platform,
              icon,
              created_at: outcome.createdAt,
              last_seen_at: outcome.lastSeenAt,
            },
            new Set(outcome.online),
          ),
        };
      }).pipe(Effect.catchTags({ UnknownError: unavailable("enroll") })),
    ),
  );

  const devices = HttpApiBuilder.group(HubApi, "devices", (handle) =>
    handle
      .handle("listDevices", () =>
        Effect.gen(function* () {
          const { accountId } = yield* HubDevice;
          const [rows, online] = yield* Effect.all(
            [registry.listAccount(accountId), presenceOrNone(accountId)],
            { concurrency: 2 },
          );
          return { devices: rows.map((row) => toDeviceInfo(row, online)) };
        }).pipe(Effect.catchTags({ RegistryError: unavailable("list") })),
      )
      // A device of another account gets the same refusal as a
      // nonexistent one, so the route leaks nothing about foreign ids:
      // the object deletes the row scoped to the account, which also
      // spares a row concurrently re-enrolled under another account.
      .handle("revokeDevice", ({ params }) =>
        Effect.gen(function* () {
          const { accountId } = yield* HubDevice;
          const removed = yield* Effect.tryPromise(() =>
            accountHub(env, accountId).revoke(params.deviceId, accountId),
          );
          if (!removed) {
            return yield* new HubUnknownDeviceError({
              deviceId: params.deviceId,
            });
          }
          yield* tearDownTunnel(accountId, params.deviceId);
        }).pipe(Effect.catchTags({ UnknownError: unavailable("revoke") })),
      )
      .handle("updateDevice", ({ params, payload }) =>
        Effect.gen(function* () {
          const { accountId } = yield* HubDevice;
          const updated = yield* registry.update(
            params.deviceId,
            accountId,
            payload,
          );
          if (!updated) {
            return yield* new HubUnknownDeviceError({
              deviceId: params.deviceId,
            });
          }
        }).pipe(Effect.catchTags({ RegistryError: unavailable("update") })),
      )
      .handle("mintTicket", ({ payload }) =>
        Effect.gen(function* () {
          const device = yield* HubDevice;
          const signingKey = env.TICKET_SIGNING_KEY ?? "";
          if (signingKey === "") {
            return yield* new HubTicketSigningUnconfiguredError();
          }
          const random = yield* Effect.tryPromise(() =>
            accountHub(env, device.accountId).mintTicket({
              deviceId: device.deviceId,
              connectionId: payload.connectionId,
              credentialHash: device.credentialHash,
            }),
          ).pipe(Effect.catchTags({ UnknownError: unavailable("ticket") }));
          const ticket = yield* Effect.promise(() =>
            buildTicket(signingKey, device.accountId, random),
          );
          return { ticket };
        }),
      )
      // Creates or reuses this device's named tunnel, points its ingress
      // at the presented loopback port, and answers the hostname and
      // the connector run token.
      .handle("provisionTunnel", ({ payload }) =>
        Effect.gen(function* () {
          const device = yield* HubDevice;
          const cf = tunnelEnvOf(env);
          if (cf === null) return yield* new HubTunnelUnconfiguredError();
          return yield* Effect.tryPromise(() =>
            provisionTunnel(
              cf,
              cfFetch,
              device.accountId,
              device.deviceId,
              payload.port,
            ),
          ).pipe(Effect.catchTags({ UnknownError: unavailable("tunnel") }));
        }),
      ),
  );

  // The ticket's account half routes to the object without a database
  // read. A ticket that is malformed or not signed by this Worker
  // cannot even name an object, which keeps this unauthenticated route
  // from instantiating objects of a caller's choosing. Everything past
  // that (unknown, expired, replayed) is the object's call, a close
  // code after the upgrade.
  const socket = HttpApiBuilder.group(HubApi, "socket", (handle) =>
    handle.handle("connect", ({ request, query }) =>
      Effect.gen(function* () {
        if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
          return yield* new HubUpgradeRequiredError();
        }
        const signingKey = env.TICKET_SIGNING_KEY ?? "";
        const ticket = query.ticket;
        const parsed =
          signingKey === "" || ticket === undefined
            ? null
            : yield* Effect.promise(() => parseTicket(signingKey, ticket));
        if (parsed === null) return yield* new HubTicketMalformedError();
        const source = request.source;
        if (!(source instanceof Request)) {
          return yield* Effect.die("the connect route serves web requests");
        }
        const url = new URL("https://device-hub.internal/");
        url.searchParams.set(CONNECT_RANDOM_PARAM, parsed.random);
        const upgraded = yield* Effect.promise(() =>
          accountHub(env, parsed.accountId).fetch(new Request(url, source)),
        );
        // A fresh Response: the object's has immutable headers, and the
        // CORS middleware writes into it on the way out.
        return HttpServerResponse.raw(
          new Response(null, { status: 101, webSocket: upgraded.webSocket }),
        );
      }),
    ),
  );

  return Layer.mergeAll(enrollment, devices, socket);
});

// ---- Rate limiting and CORS ----

// How long a limited caller is told to wait, the limiters' period in
// wrangler.jsonc.
const RATE_LIMIT_PERIOD_SECONDS = 60;

// The routes where a caller with no credential still makes the Worker
// do real work (a sign-in checked at Clerk, an object woken), by the
// route the router matched, however the request spelled its path. The
// router keys a route on its declared path, which these, having no
// params, are as written.
const OPEN_ROUTES: ReadonlySet<string> = new Set(
  [
    HubApi.groups.enrollment.endpoints.enroll,
    HubApi.groups.socket.endpoints.connect,
  ].map((endpoint) => `${endpoint.method} ${endpoint.path}`),
);

// Keyed on the client IP because most callers here have no verified
// identity yet, and the work worth bounding happens before one could be
// established. Cloudflare sets CF-Connecting-IP on every request that
// arrives through the edge and a client cannot strip it, so its absence
// means the request did not come through the edge at all (a bare
// `wrangler dev`), where there is nothing to protect. A limiter
// failure fails open: throttling is a cost guard, and it must never be
// the reason a device cannot reach its hub. It runs on a matched route,
// before the route's auth; a preflight never reaches it (cors answers
// it), and a path no route matches does no work.
const rateLimit = HttpRouter.middleware(
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const ip = request.headers["cf-connecting-ip"];
        if (ip === undefined) return yield* httpEffect;
        const { route } = yield* HttpRouter.RouteContext;
        const limiter = OPEN_ROUTES.has(`${route.method} ${route.path}`)
          ? env.RATE_LIMIT_OPEN
          : env.RATE_LIMIT;
        const { success } = yield* Effect.tryPromise(() =>
          limiter.limit({ key: ip }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("hub: rate limiter failed open", cause).pipe(
              Effect.as({ success: true }),
            ),
          ),
        );
        if (success) return yield* httpEffect;
        return HttpServerResponse.empty({
          status: 429,
          headers: { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) },
        });
      });
  }),
);

// A request that failed past every typed answer (a defect, which the
// router answers as a 500) logs it once, by the route it matched,
// never the request's URL, whose query can hold a ticket. A malformed
// request's 400 is a defect marked ignored, and an unmatched path never
// reaches a route, so neither is logged.
const logFailures = HttpRouter.middleware((httpEffect) =>
  Effect.tapCause(httpEffect, (cause) =>
    Effect.gen(function* () {
      const defects = cause.reasons.filter(
        (reason) =>
          Cause.isDieReason(reason) && !ErrorReporter.isIgnored(reason.defect),
      );
      if (defects.length === 0) return;
      const { route } = yield* HttpRouter.RouteContext;
      yield* Effect.logError(
        `hub: ${route.method} ${route.path} failed`,
        Cause.fromReasons(defects),
      );
    }),
  ),
);

// Each level to the console's own, so Workers Logs files an error as
// one.
const leveledLogs = Logger.layer([
  Logger.withLeveledConsole(Logger.formatLogFmt),
]);

// Open CORS, the standard shape for a bearer-token API. Every route
// authenticates from an explicit Authorization header, so no ambient
// credential exists for a hostile page to ride: it cannot read the
// token out of another origin's localStorage, and cookies are never
// sent (no Allow-Credentials, which "*" forbids anyway). A cross-origin
// caller gets exactly what curl gets unauthenticated, so an origin
// allowlist would buy no security while breaking every client not
// served from one origin. The preflight is cached for a day.
const cors = HttpRouter.middleware(
  HttpMiddleware.cors({
    allowedMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", PROTOCOL_HEADER],
    maxAge: 86400,
  }),
  { global: true },
);

// ---- The Worker ----

export function createWorker(deps: HubDeps): HubWorker {
  // The handler for each environment, built on its first request.
  const built = new WeakMap<
    Env,
    (request: Request, context: Context.Context<WaitUntil>) => Promise<Response>
  >();

  function handlerFor(env: Env) {
    const existing = built.get(env);
    if (existing !== undefined) return existing;
    const services = Layer.mergeAll(
      Registry.layer,
      Layer.succeed(LoginVerifier, (token: string) =>
        deps.verifyLogin(token, env),
      ),
      Layer.succeed(CfFetch, deps.cfFetch ?? fetch),
    ).pipe(Layer.provideMerge(Layer.succeed(WorkerEnv, env)));
    const api = HttpApiBuilder.layer(HubApi).pipe(
      Layer.provide(Layer.unwrap(handlers)),
      Layer.provide([loginAuth, deviceAuth, protocolFloor]),
      Layer.provide(rateLimit.layer),
      Layer.provide(logFailures.layer),
      Layer.provide(cors),
      // Merged, not provided: the router's own middleware runs on what
      // the built layer outputs, outside the API's handlers.
      Layer.provideMerge(leveledLogs),
      Layer.provide(services),
      Layer.provide(HttpServer.layerServices),
    );
    const { handler } = HttpRouter.toWebHandler(api, { disableLogger: true });
    built.set(env, handler);
    return handler;
  }

  return {
    async fetch(request, env, ctx) {
      return await handlerFor(env)(
        request,
        Context.make(WaitUntil, (promise) => ctx.waitUntil(promise)),
      );
    },
  };
}
