// The typed HTTP client for the relay Worker's device and ticket
// endpoints. Pure: it takes a base URL and an injected fetch, uses the
// shared route table and zod schemas from shared/relay/protocol.ts, and
// imports no electron and no node builtins, so the account check script
// can drive every method with a recording fetch stub.
//
// Auth-tier discipline lives here. enroll is the only call that carries
// the OAuth login token. listDevices, revoke and mintTicket carry the
// long-lived device credential the enroll response returned. Mixing the
// two would either leak the login token past its one use or try to enroll
// under a credential the endpoint does not accept.
import {
  DeviceListResponseSchema,
  EnrollRequestSchema,
  EnrollResponseSchema,
  ErrorBodySchema,
  RELAY_ROUTES,
  TicketResponseSchema,
  type DeviceInfo,
  type EnrollResponse,
  type TicketResponse,
} from "@shared/relay/protocol";

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
  enroll(loginToken: string, fields: EnrollFields): Promise<EnrollResponse>;
  listDevices(credential: string): Promise<DeviceInfo[]>;
  revoke(credential: string, deviceId: string): Promise<void>;
  mintTicket(credential: string): Promise<TicketResponse>;
};

// Turns a non-2xx response into a thrown Error carrying the relay's own
// `{ error }` message when the body parses, else the status code. The one
// place a failed relay call becomes an exception.
async function fail(response: Response): Promise<never> {
  let message = `relay request failed with status ${response.status}`;
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) message = parsed.data.error;
  } catch {
    // Non-JSON or unreadable body. The status-code message stands.
  }
  throw new Error(message);
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

  return {
    async enroll(loginToken, fields) {
      // Validate the body before sending so a bad deviceId/name/platform
      // fails here with a clear zod error, not as a relay 400.
      const body = EnrollRequestSchema.parse(fields);
      const response = await doFetch(urlFor(RELAY_ROUTES.enroll.path), {
        method: RELAY_ROUTES.enroll.method,
        headers: {
          authorization: `Bearer ${loginToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) return fail(response);
      return EnrollResponseSchema.parse(await response.json());
    },

    async listDevices(credential) {
      const response = await doFetch(urlFor(RELAY_ROUTES.listDevices.path), {
        method: RELAY_ROUTES.listDevices.method,
        headers: { authorization: `Bearer ${credential}` },
      });
      if (!response.ok) return fail(response);
      return DeviceListResponseSchema.parse(await response.json()).devices;
    },

    async revoke(credential, deviceId) {
      const response = await doFetch(
        urlFor(RELAY_ROUTES.revokeDevice.path(deviceId)),
        {
          method: RELAY_ROUTES.revokeDevice.method,
          headers: { authorization: `Bearer ${credential}` },
        },
      );
      // The relay answers a successful revoke with 204 No Content. Any
      // other non-2xx is a real failure.
      if (!response.ok) return fail(response);
    },

    async mintTicket(credential) {
      const response = await doFetch(urlFor(RELAY_ROUTES.mintTicket.path), {
        method: RELAY_ROUTES.mintTicket.method,
        headers: { authorization: `Bearer ${credential}` },
      });
      if (!response.ok) return fail(response);
      return TicketResponseSchema.parse(await response.json());
    },
  };
}
