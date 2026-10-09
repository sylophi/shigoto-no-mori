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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  HubCredentialRejectedError,
  HubDevice,
  HubDeviceEnrolledElsewhereError,
  HubDeviceRevokedError,
  HubLogin,
  HubLoginRejectedError,
  HubTicketMalformedError,
  HubTicketSigningUnconfiguredError,
  HubTunnelUnconfiguredError,
  HubUnavailableError,
  HubUnknownDeviceError,
  HubUpgradeRequiredError,
  LoginAuth,
} from "@shigomori/contracts/hubApi";
import {
  type DeviceInfoWire,
  MAX_ACCOUNT_DEVICES,
} from "@shigomori/contracts/hubProtocol";
import { randomBase64url, sha256Hex } from "./crypto.ts";
import { type Env, WaitUntil, WorkerEnv } from "./env.ts";
import { CONNECT_RANDOM_PARAM } from "./hubObject.ts";
import * as Registry from "./Registry.ts";
import {
  DEVICE_CREDENTIAL_PREFIX,
  TICKET_TTL_MS,
  buildTicket,
  parseTicket,
} from "./ticket.ts";
import { provisionTunnel, teardownTunnel, tunnelEnvOf } from "./tunnel.ts";

export interface HubDeps {
  // Resolves the enroll bearer (a Clerk session token) to the owning
  // account, or null when it does not verify. Injected so the test
  // suite never talks to real Clerk.
  verifyLogin(token: string, env: Env): Promise<{ accountId: string } | null>;
  // The fetch the Cloudflare tunnel API is called through, injected
  // like verifyLogin so the suite stubs the CF API inside workerd.
  // Defaults to the global fetch.
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

// ---- Auth tiers ----

const loginAuth = Layer.effect(
  LoginAuth,
  Effect.gen(function* () {
    const verify = yield* LoginVerifier;
    return LoginAuth.of({
      bearer: (effect, { credential }) =>
        Effect.gen(function* () {
          const token = Redacted.value(credential);
          // Any verification failure (expired, foreign instance,
          // malformed) reads as no login.
          const login =
            token === ""
              ? null
              : yield* Effect.promise(() => verify(token)).pipe(
                  Effect.orElseSucceed(() => null),
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
          });
        }).pipe(Effect.catchTags({ RegistryError: Effect.die })),
    });
  }),
);

// ---- Handlers ----

// One row as the API reports it, for the list and the enroll response
// alike, so the two cannot disagree about a device.
function toDeviceInfo(
  row: Omit<Registry.DeviceRow, "account_id" | "credential_hash">,
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

function ticketTtlMs(env: Env): number {
  const override = Number(env.TICKET_TTL_MS);
  return Number.isInteger(override) && override > 0 ? override : TICKET_TTL_MS;
}

// The refusal for a failed step behind a route, as a catchTags handler.
const unavailable = (operation: HubUnavailableError["operation"]) => () =>
  new HubUnavailableError({ operation });

const handlers = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const registry = yield* Registry.Registry;
  const cfFetch = yield* CfFetch;

  // Who is online in the account, from its hub object.
  const presence = (accountId: string) =>
    Effect.tryPromise(() => accountHub(env, accountId).online()).pipe(
      Effect.map((online) => new Set(online)),
    );

  // Presence is advisory in a device list, so a hub object hiccup reads
  // as every device offline rather than failing the list. At enroll it
  // matters most: the upsert has already committed the new credential,
  // and a failure would strand the client without it.
  const presenceOrNone = (accountId: string) =>
    presence(accountId).pipe(
      Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
    );

  // The revocation itself, shared by the revoke route and the enroll
  // cap's eviction. The object deletes the row scoped to the account,
  // so a row concurrently re-enrolled under another account survives
  // a stale revoke. The tunnel teardown is best-effort and finishes
  // after the response.
  const revokeAccountDevice = Effect.fn("revokeAccountDevice")(function* (
    accountId: string,
    deviceId: string,
  ) {
    yield* Effect.tryPromise(() =>
      accountHub(env, accountId).revoke(deviceId, accountId),
    );
    const cf = tunnelEnvOf(env);
    if (cf !== null) {
      const waitUntil = yield* WaitUntil;
      waitUntil(teardownTunnel(cf, cfFetch, accountId, deviceId));
    }
  });

  const enrollment = HttpApiBuilder.group(HubApi, "enrollment", (handle) =>
    handle.handle("enroll", ({ payload }) =>
      Effect.gen(function* () {
        const { accountId } = yield* HubLogin;
        const { deviceId, name, platform, icon } = payload;
        const existing = yield* registry.byId(deviceId);
        if (existing !== null && existing.account_id !== accountId) {
          return yield* new HubDeviceEnrolledElsewhereError();
        }
        // The cap counts new devices only, so a full account can still
        // re-enroll the devices it has. A pre-read rather than a SQL
        // guard: two racing enrolls can land one over, which a quota
        // shrugs off.
        //
        // A full account makes room by dropping its stalest offline
        // device rather than refusing. Removing a device takes a device
        // credential, and a browser profile that cleared its storage has
        // lost its own, so a refusal could lock an account out with
        // nothing left to remove devices from. The login authorizing
        // this enroll is the account owner's, and the evicted device
        // only has to sign in again.
        if (existing === null) {
          const stalestFirst = yield* registry.stalestFirst(accountId);
          if (stalestFirst.length >= MAX_ACCOUNT_DEVICES) {
            // Not the advisory presence: failing open to "all offline"
            // would evict the stalest device whether or not it is
            // online. A presence the object cannot answer refuses the
            // enroll instead.
            const online = yield* presence(accountId);
            const evict = stalestFirst.find((id) => !online.has(id));
            if (evict === undefined) {
              return yield* new HubAccountFullError({
                limit: MAX_ACCOUNT_DEVICES,
              });
            }
            yield* revokeAccountDevice(accountId, evict);
          }
        }
        // Enrolling again rotates the credential: exactly one credential
        // per device is valid at any time, because only one hash is
        // stored.
        const credential = DEVICE_CREDENTIAL_PREFIX + randomBase64url(32);
        const createdAt =
          existing?.created_at ??
          (yield* Effect.clockWith((clock) => clock.currentTimeMillis));
        const [wrote, online] = yield* Effect.all(
          [
            Effect.flatMap(
              Effect.promise(() => sha256Hex(credential)),
              (credentialHash) =>
                registry.upsert({
                  deviceId,
                  accountId,
                  name,
                  platform,
                  icon,
                  credentialHash,
                  createdAt,
                }),
            ),
            presenceOrNone(accountId),
          ],
          { concurrency: 2 },
        );
        // The statement's account guard is the real enforcement against
        // a cross-account enroll racing the pre-read above: zero changes
        // means it suppressed one.
        if (!wrote) return yield* new HubDeviceEnrolledElsewhereError();
        return {
          credential,
          device: toDeviceInfo(
            {
              device_id: deviceId,
              name,
              platform,
              icon,
              created_at: createdAt,
              last_seen_at: existing?.last_seen_at ?? null,
            },
            online,
          ),
        };
      }).pipe(
        Effect.catchTags({
          RegistryError: unavailable("enroll"),
          UnknownError: unavailable("enroll"),
        }),
      ),
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
      // nonexistent one, so the route leaks nothing about foreign ids.
      .handle("revokeDevice", ({ params }) =>
        Effect.gen(function* () {
          const { accountId } = yield* HubDevice;
          const target = yield* registry.byId(params.deviceId);
          if (target === null || target.account_id !== accountId) {
            return yield* new HubUnknownDeviceError({
              deviceId: params.deviceId,
            });
          }
          yield* revokeAccountDevice(accountId, params.deviceId);
        }).pipe(
          Effect.catchTags({
            RegistryError: unavailable("revoke"),
            UnknownError: unavailable("revoke"),
          }),
        ),
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
      .handle("mintTicket", () =>
        Effect.gen(function* () {
          const device = yield* HubDevice;
          const signingKey = env.TICKET_SIGNING_KEY ?? "";
          if (signingKey === "") {
            return yield* new HubTicketSigningUnconfiguredError();
          }
          const ttlMs = ticketTtlMs(env);
          const random = yield* Effect.tryPromise(() =>
            accountHub(env, device.accountId).mintTicket(
              device.deviceId,
              ttlMs,
            ),
          ).pipe(Effect.catchTags({ UnknownError: unavailable("ticket") }));
          const ticket = yield* Effect.promise(() =>
            buildTicket(signingKey, device.accountId, random),
          );
          return { ticket, expiresInMs: ttlMs };
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

// Keyed on the client IP because most callers here have no verified
// identity yet, and the work worth bounding happens before one could be
// established. Cloudflare sets CF-Connecting-IP on every request that
// arrives through the edge and a client cannot strip it, so its absence
// means the request did not come through the edge at all (the suite, a
// bare `wrangler dev`), where there is nothing to protect. A limiter
// failure fails open: throttling is a cost guard, and it must never be
// the reason a device cannot reach its hub. A preflight does no work
// worth limiting, and a 429 on one would only surface in the browser as
// an opaque CORS failure.
const rateLimit = HttpRouter.middleware(
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const ip = request.headers["cf-connecting-ip"];
        if (ip === undefined || request.method === "OPTIONS") {
          return yield* httpEffect;
        }
        // Enroll and connect, the two routes where a caller with no
        // credential still makes the Worker do real work, draw on the
        // tighter budget.
        const path = new URL(request.originalUrl, "http://hub").pathname;
        const open =
          (request.method === "POST" && path === "/devices/enroll") ||
          (request.method === "GET" && path === "/connect");
        const limiter = open ? env.RATE_LIMIT_OPEN : env.RATE_LIMIT;
        const { success } = yield* Effect.tryPromise(() =>
          limiter.limit({ key: ip }),
        ).pipe(Effect.orElseSucceed(() => ({ success: true })));
        if (success) return yield* httpEffect;
        return HttpServerResponse.empty({
          status: 429,
          headers: { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) },
        });
      });
  }),
  { global: true },
);

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
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }),
  { global: true },
);

// ---- The Worker ----

export function createWorker(deps: HubDeps): HubWorker {
  // The handler for each environment, built on its first request. One
  // deployment has one, and the suite stands in a few of its own.
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
      Layer.provide([loginAuth, deviceAuth]),
      Layer.provide(rateLimit),
      Layer.provide(cors),
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
