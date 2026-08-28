// The typed HTTP client for the relay Worker's device and ticket
// endpoints. Pure: it takes a base URL and an injected fetch, uses the
// shared route table and zod schemas from shared/relay/protocol.ts, and
// imports no electron and no node builtins, so the account check script
// can drive every method with a recording fetch stub.
//
// Auth-tier discipline lives here. enroll is the only call that carries
// the short-lived Clerk session token proving the sign-in. listDevices,
// revoke and mintTicket carry the long-lived device credential the
// enroll response returned. Mixing the two would either leak the login
// token past its one use or try to enroll under a credential the
// endpoint does not accept.
import {
  DeviceListResponseSchema,
  EnrollRequestSchema,
  EnrollResponseSchema,
  ErrorBodySchema,
  RELAY_ROUTES,
  TicketResponseSchema,
  TUNNEL_UNCONFIGURED_STATUS,
  TunnelProvisionRequestSchema,
  TunnelProvisionResponseSchema,
  type DeviceInfo,
  type EnrollResponse,
  type TicketResponse,
  type TunnelProvisionResponse,
} from "@shared/relay/protocol";

// A relay call answered non-2xx. Carries the HTTP status so callers
// that classify outcomes (the tunnel provision path) can read it off
// the error instead of re-fetching. The message is still the relay's
// own `{ error }` body when one parsed, so existing message matchers
// keep working.
export class RelayRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RelayRequestError";
    this.status = status;
  }
}

// The Worker answered the typed "tunnel provisioning is not
// configured" status. A deployment fact, not a failure: the caller
// (the cloudflared runner) reads it as "tunnels off, do not retry"
// rather than backing off into a loop that can never succeed.
export class TunnelUnconfiguredError extends Error {
  constructor() {
    super("tunnel provisioning is not configured on the relay");
    this.name = "TunnelUnconfiguredError";
  }
}

// The Worker refused this device's provision outright: a 401 from a
// revoked credential, a 404 from an older Worker deploy with no tunnel
// route. Terminal until the runner's inputs change (the next reconcile
// trigger): a timed retry re-presents the same refused request, so the
// runner parks instead of retrying on a schedule.
export class TunnelProvisionDeniedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TunnelProvisionDeniedError";
    this.status = status;
  }
}

export type AccountServiceDeps = {
  baseUrl: string;
  // Injected so tests avoid the network. Defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

export type EnrollFields = {
  deviceId: string;
  name: string;
  platform: string;
};

export type AccountService = {
  enroll(sessionToken: string, fields: EnrollFields): Promise<EnrollResponse>;
  listDevices(credential: string): Promise<DeviceInfo[]>;
  revoke(credential: string, deviceId: string): Promise<void>;
  // signal aborts the mint fetch on stop or on the caller's mint
  // timeout, so a black-holed route cannot hang the connect (C6).
  mintTicket(credential: string, signal?: AbortSignal): Promise<TicketResponse>;
  // Provision (or re-point) this device's named tunnel to front the
  // given loopback port (v2 step 10, slice B). Throws
  // TunnelUnconfiguredError when the Worker has no tunnel env and
  // TunnelProvisionDeniedError on any other 4xx (both terminal for the
  // runner, in different ways). The returned connectorToken is a
  // bearer secret: callers keep it in memory, pass it to cloudflared
  // via env, and never log it.
  provisionTunnel(
    credential: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<TunnelProvisionResponse>;
};

// Turns a non-2xx response into a thrown RelayRequestError carrying the
// relay's own `{ error }` message when the body parses, else the status
// code. The one place a failed relay call becomes an exception.
async function fail(response: Response): Promise<never> {
  let message = `relay request failed with status ${response.status}`;
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) message = parsed.data.error;
  } catch {
    // Non-JSON or unreadable body. The status-code message stands.
  }
  throw new RelayRequestError(message, response.status);
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const doFetch = deps.fetchImpl ?? fetch;

  // Joins a relay path onto the base URL. new URL keeps a base with a
  // path prefix intact by making the route absolute-rooted.
  const urlFor = (path: string): string => {
    const base = deps.baseUrl.endsWith("/")
      ? deps.baseUrl.slice(0, -1)
      : deps.baseUrl;
    return `${base}${path}`;
  };

  // The one bearer-header/ok-check/parse dance every route shares:
  // fetch under the given bearer (the Clerk session token for enroll,
  // the device credential for everything else), throw the typed failure on
  // non-2xx, and hand back the parsed JSON body (undefined for the
  // 204s, which have no body to parse).
  const credentialed = async (
    route: { method: string },
    path: string,
    bearer: string,
    init: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> => {
    const response = await doFetch(urlFor(path), {
      method: route.method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    if (!response.ok) return fail(response);
    return response.status === 204 ? undefined : response.json();
  };

  return {
    async enroll(sessionToken, fields) {
      // Validate the body before sending so a bad deviceId/name/platform
      // fails here with a clear zod error, not as a relay 400.
      const body = EnrollRequestSchema.parse(fields);
      return EnrollResponseSchema.parse(
        await credentialed(
          RELAY_ROUTES.enroll,
          RELAY_ROUTES.enroll.path,
          sessionToken,
          { body },
        ),
      );
    },

    async listDevices(credential) {
      return DeviceListResponseSchema.parse(
        await credentialed(
          RELAY_ROUTES.listDevices,
          RELAY_ROUTES.listDevices.path,
          credential,
        ),
      ).devices;
    },

    async revoke(credential, deviceId) {
      // The relay answers a successful revoke with 204 No Content. Any
      // other non-2xx is a real failure.
      await credentialed(
        RELAY_ROUTES.revokeDevice,
        RELAY_ROUTES.revokeDevice.path(deviceId),
        credential,
      );
    },

    async mintTicket(credential, signal) {
      return TicketResponseSchema.parse(
        await credentialed(
          RELAY_ROUTES.mintTicket,
          RELAY_ROUTES.mintTicket.path,
          credential,
          { signal },
        ),
      );
    },

    async provisionTunnel(credential, port, signal) {
      // Validate before sending, like enroll, so a bad port fails here
      // with a clear zod error instead of a relay 400.
      const body = TunnelProvisionRequestSchema.parse({ port });
      try {
        return TunnelProvisionResponseSchema.parse(
          await credentialed(
            RELAY_ROUTES.provisionTunnel,
            RELAY_ROUTES.provisionTunnel.path,
            credential,
            { body, signal },
          ),
        );
      } catch (error) {
        // The provision-specific failure classes, layered on the
        // shared dance: 501 is the Worker's typed "no tunnel env",
        // any other 4xx is a refusal that a timed retry cannot change
        // (revoked credential, older Worker deploy). 5xx and network
        // failures rethrow as-is and stay retryable.
        if (error instanceof RelayRequestError) {
          if (error.status === TUNNEL_UNCONFIGURED_STATUS) {
            throw new TunnelUnconfiguredError();
          }
          if (error.status >= 400 && error.status < 500) {
            throw new TunnelProvisionDeniedError(error.message, error.status);
          }
        }
        throw error;
      }
    },
  };
}
