// The relay Worker's HTTP surface. All routing and endpoint logic
// lives in createWorker(deps) so tests can inject a stub Clerk
// verifier, index.ts wires the real one. Routes are matched against
// the shared RELAY_ROUTES table, so the app-side client cannot drift
// from what is served here.
//
// Auth is two-tier. POST /devices/enroll takes the OAuth access token
// the app's PKCE flow obtained, verified through deps.verifyLogin.
// Everything else takes the long-lived device credential, resolved by
// hashing it and looking up the unique hash in D1. The credential only
// ever rides in the Authorization header. The only secret allowed in a
// URL is the single-use connection ticket on GET /connect, because
// websocket clients cannot set headers.
import {
  CONNECT_TICKET_PARAM,
  type DeviceInfo,
  type DeviceListResponse,
  type EnrollResponse,
  EnrollRequestSchema,
  type ErrorBody,
  RELAY_ROUTES,
  type TicketResponse,
  TUNNEL_UNCONFIGURED_STATUS,
  type TunnelProvisionResponse,
  TunnelProvisionRequestSchema,
} from "../../shared/relay/protocol.ts";
import { provisionTunnel, teardownTunnel, tunnelEnvOf } from "./tunnel.ts";
import {
  DEVICE_CREDENTIAL_PREFIX,
  TICKET_TTL_MS,
  buildTicket,
  parseTicket,
} from "./ticket.ts";
import type { Env } from "./env.ts";
import {
  type DeviceRow,
  getDeviceByCredentialHash,
  getDeviceById,
  listDevicesByCredentialHash,
  upsertDevice,
} from "./db.ts";
import { randomBase64url, sha256Hex } from "./crypto.ts";
import {
  INTERNAL_CONNECT_PATH,
  INTERNAL_PRESENCE_PATH,
  INTERNAL_REVOKE_PATH,
  INTERNAL_TICKET_PATH,
  type MintTicketRequest,
  type MintTicketResponse,
  type PresenceResponse,
  type RevokeRequest,
} from "./relayObject.ts";

export interface RelayDeps {
  // Resolves the enroll bearer (a Clerk OAuth application access
  // token) to the owning account, or null when it does not verify.
  // Injected so the test suite never talks to real Clerk.
  verifyLogin(token: string, env: Env): Promise<{ accountId: string } | null>;
  // The fetch the Cloudflare tunnel API is called through (v2 step 10,
  // slice B). Injected like verifyLogin so the vitest suite stubs the
  // CF API inside workerd with no network. Defaults to the global
  // fetch in production (index.ts passes nothing).
  cfFetch?: typeof fetch;
}

// Structurally compatible with ExportedHandler<Env>, with fetch and
// the context required.
export interface RelayWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

// Derived from the shared route so the matcher and the client's URL
// builder cannot drift. RELAY_ROUTES.revokeDevice.path(id) returns
// `/devices/${encodeURIComponent(id)}`. The placeholder is in the
// unreserved set, so encodeURIComponent leaves it untouched, marking
// exactly where the id sits. We swap it for a single-segment capture
// group. RELAY_ROUTES is the single source of truth for the path.
const DEVICE_ID_PLACEHOLDER = "__deviceId__";
const DEVICE_PATH = new RegExp(
  `^${RELAY_ROUTES.revokeDevice
    .path(DEVICE_ID_PLACEHOLDER)
    .replace(DEVICE_ID_PLACEHOLDER, "([^/]+)")}$`,
);

// The DO stub needs an absolute URL. The host is never routable, only
// the path matters.
const DO_ORIGIN = "https://account-relay.internal";

// Error responses are compiler-checked against ErrorBody, so the
// `{ error }` contract in protocol.ts is load-bearing, not a
// convention.
function jsonError(status: number, body: ErrorBody): Response {
  return Response.json(body, { status });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function accountStub(env: Env, accountId: string): DurableObjectStub {
  return env.ACCOUNT_RELAY.get(env.ACCOUNT_RELAY.idFromName(accountId));
}

// The one path every internal DO call goes through. It checks
// response.ok and throws otherwise, so a DO 404 or 500 can never be
// mistaken for a valid body (a dead ticket, or `new Set(undefined)`).
// Every internal handler returns a JSON body, including revoke, so the
// parse is uniform. Callers either map the throw to a 502 at the two
// device-facing endpoints or let the top-level catch turn it into a
// 500.
async function callObject<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await stub.fetch(`${DO_ORIGIN}${path}`, init);
  if (!response.ok) {
    throw new Error(`durable object ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

// Resolves the presented device credential to its D1 row, null on any
// miss. The prefix check is a cheap way to keep Clerk tokens and
// credentials from ever hitting the wrong tier.
async function authDevice(
  request: Request,
  env: Env,
): Promise<DeviceRow | null> {
  const token = bearerToken(request);
  if (token === null || !token.startsWith(DEVICE_CREDENTIAL_PREFIX))
    return null;
  return await getDeviceByCredentialHash(env.DB, await sha256Hex(token));
}

async function accountPresence(
  env: Env,
  accountId: string,
): Promise<Set<string>> {
  const body = await callObject<PresenceResponse>(
    accountStub(env, accountId),
    INTERNAL_PRESENCE_PATH,
  );
  return new Set(body.online);
}

// Presence is advisory at enroll and at the device list, so a relay
// object hiccup must never block enrollment or the device list. This
// wraps accountPresence and defaults to an empty online set on any DO
// failure, reporting every device offline rather than throwing. The
// enroll case matters most: the upsert has already committed the new
// credential, so a throw here would strand the client without the raw
// credential that now guards its row.
async function accountPresenceSafe(
  env: Env,
  accountId: string,
): Promise<Set<string>> {
  try {
    return await accountPresence(env, accountId);
  } catch {
    return new Set<string>();
  }
}

function toDeviceInfo(row: DeviceRow, online: Set<string>): DeviceInfo {
  return {
    deviceId: row.device_id,
    name: row.name,
    platform: row.platform,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    online: online.has(row.device_id),
  };
}

function ticketTtlMs(env: Env): number {
  const override = Number(env.TICKET_TTL_MS);
  return Number.isInteger(override) && override > 0 ? override : TICKET_TTL_MS;
}

export function createWorker(deps: RelayDeps): RelayWorker {
  const cfFetch = deps.cfFetch ?? fetch;
  return {
    async fetch(request, env, ctx) {
      try {
        const url = new URL(request.url);

        // Origin gate. No Origin header means a non-browser client (the
        // desktop app), always allowed. A browser is only allowed when
        // its exact origin is configured as ALLOWED_WEB_ORIGIN, which
        // pre-wires the step-8 web client without loosening the
        // default. An unset ALLOWED_WEB_ORIGIN is undefined, so a
        // browser origin never equals it and is rejected.
        const origin = request.headers.get("Origin");
        if (origin !== null && origin !== env.ALLOWED_WEB_ORIGIN) {
          return jsonError(403, { error: "origin not allowed" });
        }

        // GET /connect is routed before the CORS append: a successful
        // upgrade is a 101 with immutable headers, and websocket
        // clients ignore CORS anyway.
        if (
          request.method === RELAY_ROUTES.connect.method &&
          url.pathname === RELAY_ROUTES.connect.path
        ) {
          return await connect(request, env, url);
        }

        const response = await route(request, env, url, ctx);
        // A non-null origin already passed the gate, so it is exactly
        // the configured web origin. Append CORS so the browser can
        // read the response.
        if (origin !== null) {
          response.headers.set("Access-Control-Allow-Origin", origin);
          response.headers.set(
            "Access-Control-Allow-Methods",
            "GET,POST,DELETE,OPTIONS",
          );
          response.headers.set(
            "Access-Control-Allow-Headers",
            "Authorization,Content-Type",
          );
        }
        return response;
      } catch {
        // Backstop for any unexpected throw. protocol.ts promises every
        // error response is the { error } shape, so a raw throw must
        // not escape as workerd's text 500 that ErrorBodySchema cannot
        // parse.
        return jsonError(500, { error: "internal error" });
      }
    },
  };

  async function route(
    request: Request,
    env: Env,
    url: URL,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
    if (
      request.method === RELAY_ROUTES.enroll.method &&
      url.pathname === RELAY_ROUTES.enroll.path
    ) {
      return await enroll(request, env);
    }
    if (
      request.method === RELAY_ROUTES.listDevices.method &&
      url.pathname === RELAY_ROUTES.listDevices.path
    ) {
      return await listAccountDevices(request, env);
    }
    const deviceMatch = DEVICE_PATH.exec(url.pathname);
    if (
      request.method === RELAY_ROUTES.revokeDevice.method &&
      deviceMatch !== null
    ) {
      let targetId: string;
      try {
        targetId = decodeURIComponent(deviceMatch[1]);
      } catch {
        // A malformed percent-escape (for example DELETE /devices/%,
        // reachable with no auth) throws URIError. Answer with the
        // { error } shape and a 400, never a 500.
        return jsonError(400, { error: "malformed device id" });
      }
      return await revokeDevice(request, env, targetId, ctx);
    }
    if (
      request.method === RELAY_ROUTES.mintTicket.method &&
      url.pathname === RELAY_ROUTES.mintTicket.path
    ) {
      return await mintTicket(request, env);
    }
    if (
      request.method === RELAY_ROUTES.provisionTunnel.method &&
      url.pathname === RELAY_ROUTES.provisionTunnel.path
    ) {
      return await provisionDeviceTunnel(request, env);
    }
    return jsonError(404, { error: "not found" });
  }

  async function enroll(request: Request, env: Env) {
    const token = bearerToken(request);
    const login = token === null ? null : await deps.verifyLogin(token, env);
    if (login === null) return jsonError(401, { error: "invalid login token" });
    const body = EnrollRequestSchema.safeParse(await readJson(request));
    if (!body.success)
      return jsonError(400, { error: "invalid enroll request" });
    const { deviceId, name, platform } = body.data;
    const existing = await getDeviceById(env.DB, deviceId);
    if (existing !== null && existing.account_id !== login.accountId) {
      return jsonError(409, {
        error:
          "deviceId is enrolled under a different account, revoke it there first",
      });
    }
    // Enrolling again rotates the credential: exactly one credential
    // per device is valid at any time, because only one hash is
    // stored.
    const credential = DEVICE_CREDENTIAL_PREFIX + randomBase64url(32);
    const createdAt = existing?.created_at ?? Date.now();
    // The presence lookup is independent of the upsert, so the DO
    // round trip runs while D1 writes. It is best-effort here: a
    // presence failure must not drop the credential the upsert just
    // committed.
    const presence = accountPresenceSafe(env, login.accountId);
    const wrote = await upsertDevice(env.DB, {
      deviceId,
      accountId: login.accountId,
      name,
      platform,
      credentialHash: await sha256Hex(credential),
      createdAt,
    });
    // The SQL account guard is the real enforcement against a
    // cross-account collision that races the pre-read above. A fresh
    // insert and a same-account re-enroll each write exactly one row,
    // so zero changes uniquely means the guard suppressed a
    // cross-account bind. Same verdict as the fast-path 409.
    if (!wrote) {
      // The abandoned presence promise needs no guard: accountPresenceSafe
      // never rejects.
      return jsonError(409, {
        error:
          "deviceId is enrolled under a different account, revoke it there first",
      });
    }
    const online = await presence;
    const response = {
      credential,
      device: {
        deviceId,
        name,
        platform,
        createdAt,
        lastSeenAt: existing?.last_seen_at ?? null,
        online: online.has(deviceId),
      },
    } satisfies EnrollResponse;
    return Response.json(response);
  }

  async function listAccountDevices(request: Request, env: Env) {
    const token = bearerToken(request);
    if (token === null || !token.startsWith(DEVICE_CREDENTIAL_PREFIX))
      return jsonError(401, { error: "invalid device credential" });
    // Auth and list fold into one query: the subquery resolves the
    // account from the credential hash and the outer query returns that
    // account's devices. An empty result means the credential matched
    // nothing.
    const rows = await listDevicesByCredentialHash(
      env.DB,
      await sha256Hex(token),
    );
    if (rows.length === 0)
      return jsonError(401, { error: "invalid device credential" });
    // Every row shares the account, so the first row names the DO for
    // presence. Presence is advisory here, so a relay object hiccup
    // never blocks the device list. A failure defaults to all offline.
    const online = await accountPresenceSafe(env, rows[0].account_id);
    const response = {
      devices: rows.map((row) => toDeviceInfo(row, online)),
    } satisfies DeviceListResponse;
    return Response.json(response);
  }

  // Any device of the account may revoke any device of the account,
  // including itself. A device of another account gets the same 404 as
  // a nonexistent one, so the endpoint leaks nothing about foreign
  // deviceIds. The revocation itself (D1 row, live sockets, unconsumed
  // tickets) is one operation owned by the Durable Object.
  async function revokeDevice(
    request: Request,
    env: Env,
    targetId: string,
    ctx: ExecutionContext,
  ) {
    // The caller auth and the target lookup are independent reads, so
    // they run together.
    const [device, target] = await Promise.all([
      authDevice(request, env),
      getDeviceById(env.DB, targetId),
    ]);
    if (device === null)
      return jsonError(401, { error: "invalid device credential" });
    if (target === null || target.account_id !== device.account_id) {
      return jsonError(404, { error: "unknown device" });
    }
    // The account is threaded into the revoke so the DO's D1 delete is
    // scoped to it and cannot delete a row concurrently re-enrolled
    // under another account. A DO failure surfaces as a 502.
    try {
      await callObject(
        accountStub(env, device.account_id),
        INTERNAL_REVOKE_PATH,
        {
          method: "POST",
          body: JSON.stringify({
            deviceId: targetId,
            accountId: device.account_id,
          } satisfies RevokeRequest),
        },
      );
    } catch {
      return jsonError(502, { error: "revocation failed" });
    }
    // Best-effort tunnel teardown (v2 step 10, slice B): the revoked
    // device's named tunnel and DNS record die with it when the tunnel
    // env is configured. teardownTunnel swallows every CF failure
    // itself, so it can never fail a revoke the DO already committed,
    // and it rides waitUntil so the caller's 204 never waits on the CF
    // API either.
    const cf = tunnelEnvOf(env);
    if (cf !== null) {
      ctx.waitUntil(teardownTunnel(cf, cfFetch, device.account_id, targetId));
    }
    return new Response(null, { status: 204 });
  }

  // Tunnel provisioning (v2 step 10, slice B): create-or-reuse this
  // device's named tunnel, point its ingress at the presented loopback
  // port, ensure the DNS CNAME and answer the hostname plus the
  // connector run token. Device-credential authed like mintTicket.
  // Unconfigured env answers the typed status so the app can gate
  // tunnels off without treating it as a failure.
  async function provisionDeviceTunnel(request: Request, env: Env) {
    const device = await authDevice(request, env);
    if (device === null)
      return jsonError(401, { error: "invalid device credential" });
    const cf = tunnelEnvOf(env);
    if (cf === null) {
      return jsonError(TUNNEL_UNCONFIGURED_STATUS, {
        error: "tunnel provisioning is not configured",
      });
    }
    const body = TunnelProvisionRequestSchema.safeParse(
      await readJson(request),
    );
    if (!body.success)
      return jsonError(400, { error: "invalid tunnel request" });
    try {
      const provisioned = await provisionTunnel(
        cf,
        cfFetch,
        device.account_id,
        device.device_id,
        body.data.port,
      );
      return Response.json(provisioned satisfies TunnelProvisionResponse);
    } catch {
      // The CF API refused or misbehaved. A 502 keeps the { error }
      // contract and the app's runner backs off and retries later.
      return jsonError(502, { error: "tunnel provisioning failed" });
    }
  }

  async function mintTicket(request: Request, env: Env) {
    const device = await authDevice(request, env);
    if (device === null)
      return jsonError(401, { error: "invalid device credential" });
    const ttlMs = ticketTtlMs(env);
    let minted: MintTicketResponse;
    try {
      minted = await callObject<MintTicketResponse>(
        accountStub(env, device.account_id),
        INTERNAL_TICKET_PATH,
        {
          method: "POST",
          body: JSON.stringify({
            deviceId: device.device_id,
            ttlMs,
          } satisfies MintTicketRequest),
        },
      );
    } catch {
      return jsonError(502, { error: "ticket service unavailable" });
    }
    const body = {
      ticket: buildTicket(device.account_id, minted.random),
      expiresInMs: ttlMs,
    } satisfies TicketResponse;
    return Response.json(body);
  }

  // The ticket's account half routes to the DO without a D1 hit. A
  // structurally malformed ticket cannot even name a DO and is
  // rejected here with plain HTTP. Everything past parsing (unknown,
  // expired, replayed) is the DO's call and surfaces as a close code
  // after the upgrade, see AccountRelay.rejectSocket.
  async function connect(request: Request, env: Env, url: URL) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonError(426, { error: "websocket upgrade required" });
    }
    const ticket = url.searchParams.get(CONNECT_TICKET_PARAM);
    const parsed = ticket === null ? null : parseTicket(ticket);
    if (parsed === null) return jsonError(403, { error: "malformed ticket" });
    const doUrl = new URL(`${DO_ORIGIN}${INTERNAL_CONNECT_PATH}`);
    doUrl.searchParams.set("random", parsed.random);
    return await accountStub(env, parsed.accountId).fetch(
      new Request(doUrl, request),
    );
  }
}
