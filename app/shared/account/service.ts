// The hub Worker's device and ticket routes, through the client derived
// from the shared HubApi (packages/contracts/src/hubApi.ts), behind the
// Promise face the account layer calls. Pure: it takes a base URL and
// an injected fetch and imports no electron and no node builtins, so
// the account proof drives every method with a recording fetch stub.
//
// A call rejects with the hub's refusal as its contract error
// (HubDeviceRevokedError, HubUnknownDeviceError, ...), or with an
// HttpClientError when the hub could not be reached or answered
// something the API does not name (a 429, a bare 5xx).
//
// Auth-tier discipline lives here. enroll is the only call that carries
// the short-lived Clerk session token proving the sign-in. listDevices,
// revoke and mintTicket carry the long-lived device credential the
// enroll response returned. Mixing the two would either leak the login
// token past its one use or try to enroll under a credential the
// endpoint does not accept.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import {
  HubApi,
  HubTunnelUnconfiguredError,
  isHubRefusal,
} from "@shigomori/contracts/hubApi";
import {
  DeviceListResponseSchema,
  type DevicePatch,
  EnrollResponseSchema,
  type DeviceInfo,
  type EnrollResponse,
  type TicketResponse,
  type TunnelProvisionResponse,
} from "@shigomori/contracts/hubProtocol";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";

// The hub could not be reached at all: offline, a DNS or TLS failure,
// or a browser hiding a failed response behind CORS.
export function isHubUnreachable(error: unknown): boolean {
  return (
    HttpClientError.isHttpClientError(error) &&
    error.reason instanceof HttpClientError.TransportError
  );
}

// The Worker refused this device's provision outright: a refusal of its
// credential, or a request it will not serve (an older Worker with no
// tunnel route). Terminal until the runner's inputs change (the next
// reconcile trigger): a timed retry re-presents the same refused
// request, so the runner parks instead of retrying on a schedule.
export class TunnelProvisionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelProvisionDeniedError";
  }
}

// A status the API names no error for, from a client error that is not
// the rate limiter's: the same request will be refused again.
function isRefusedStatus(error: unknown): boolean {
  if (
    !HttpClientError.isHttpClientError(error) ||
    !("response" in error.reason)
  ) {
    return false;
  }
  const status = error.reason.response.status;
  return status >= 400 && status < 500 && status !== 429;
}

type AccountServiceDeps = {
  baseUrl: string;
  // Injected so tests avoid the network. Defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

type EnrollFields = {
  deviceId: string;
  name: string;
  platform: string;
  icon: DeviceIcon;
};

export type AccountService = {
  enroll(sessionToken: string, fields: EnrollFields): Promise<EnrollResponse>;
  listDevices(credential: string): Promise<DeviceInfo[]>;
  revoke(
    credential: string,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  // Changes a device of the account on the hub (its name, its icon, or
  // both), so the registry the other devices list carries the change
  // at once.
  update(
    credential: string,
    deviceId: string,
    patch: DevicePatch,
  ): Promise<void>;
  // signal aborts the mint on stop or on the caller's mint timeout, so
  // a black-holed route cannot hang the connect.
  mintTicket(credential: string, signal?: AbortSignal): Promise<TicketResponse>;
  // Provision (or re-point) this device's named tunnel to front the
  // given loopback port. Rejects with HubTunnelUnconfiguredError when
  // the Worker has no tunnel env and TunnelProvisionDeniedError when it
  // refuses (both terminal for the runner, in different ways). The
  // returned connectorToken is a bearer secret: callers keep it in
  // memory, pass it to cloudflared via env, and never log it.
  provisionTunnel(
    credential: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<TunnelProvisionResponse>;
};

type HubClient = HttpApiClient.ForApi<typeof HubApi>;

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;

  // One call under one bearer: the Clerk session token for enroll, the
  // device credential for everything else.
  const call = <A, E>(
    bearer: string,
    run: (client: HubClient) => Effect.Effect<A, E>,
    signal?: AbortSignal,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.flatMap(
        HttpApiClient.make(HubApi, {
          baseUrl,
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken(bearer),
          ),
        }),
        run,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchImpl),
      ),
      { signal },
    );

  return {
    async enroll(sessionToken, fields) {
      // The device as the hub stored it, mapped to this build's icon
      // catalog.
      return Schema.decodeSync(EnrollResponseSchema)(
        await call(sessionToken, (client) =>
          client.enroll({ payload: fields }),
        ),
      );
    },

    async listDevices(credential) {
      const { devices } = Schema.decodeSync(DeviceListResponseSchema)(
        await call(credential, (client) => client.listDevices()),
      );
      return [...devices];
    },

    async revoke(credential, deviceId, signal) {
      await call(
        credential,
        (client) => client.revokeDevice({ params: { deviceId } }),
        signal,
      );
    },

    async update(credential, deviceId, patch) {
      await call(credential, (client) =>
        client.updateDevice({ params: { deviceId }, payload: patch }),
      );
    },

    async mintTicket(credential, signal) {
      return await call(credential, (client) => client.mintTicket(), signal);
    },

    async provisionTunnel(credential, port, signal) {
      try {
        return await call(
          credential,
          (client) => client.provisionTunnel({ payload: { port } }),
          signal,
        );
      } catch (error) {
        // The one 4xx a retry does change is the Worker's rate limiter,
        // so it stays retryable with the 5xx and network failures.
        if (error instanceof HubTunnelUnconfiguredError) throw error;
        if (isHubRefusal(error) || isRefusedStatus(error)) {
          throw new TunnelProvisionDeniedError(
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
    },
  };
}
