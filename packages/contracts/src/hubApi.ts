// The hub Worker's HTTP API, one definition for both sides: the Worker
// serves it (hub/src/worker.ts) and the app calls it through the client
// derived from it (app/shared/account/service.ts), so a route, a body
// or a refusal cannot drift between them. The socket the devices hold
// to their account's Durable Object is hubProtocol.ts.
//
// Auth is two bearer tiers. Enrolling takes the Clerk session token
// the app's embedded sign-in minted (LoginAuth). Every other route
// takes the long-lived device credential enrolling returned
// (DeviceAuth). The only secret allowed in a URL is the single-use
// ticket on GET /connect, since a websocket client cannot set headers.
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import type { DeviceKind } from "./modules/link.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { HexId32Schema } from "./schemas/hexId.ts";
import {
  DeviceIdSchema,
  DeviceListResponseSchema,
  DevicePatchRequestSchema,
  EnrollRequestSchema,
  EnrollResponseSchema,
  TicketResponseSchema,
  TunnelProvisionRequestSchema,
  TunnelProvisionResponseSchema,
} from "./hubProtocol.ts";

// ---- Refusals ----

// The enroll bearer is not a Clerk session token of this hub's instance
// (expired, foreign, malformed, absent).
export class HubLoginRejectedError extends Schema.TaggedError<HubLoginRejectedError>()(
  "HubLoginRejectedError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "The device hub did not accept this sign-in.";
  }
}

// The device credential matches no device: garbage, rotated away by a
// re-enroll, or revoked longer ago than the hub remembers.
export class HubCredentialRejectedError extends Schema.TaggedError<HubCredentialRejectedError>()(
  "HubCredentialRejectedError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "The device hub no longer accepts this device's credential.";
  }
}

// The device credential is one a revoke killed: the device was removed
// from the account. The one refusal the app acts on by signing out, as
// on the socket's CLOSE_DEVICE_REVOKED, which only a device online at
// the revoke sees.
export class HubDeviceRevokedError extends Schema.TaggedError<HubDeviceRevokedError>()(
  "HubDeviceRevokedError",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "This device was removed from the account.";
  }
}

// The device id is enrolled under another account. A sign-out whose
// revoke never reached the hub leaves this behind (shared/account/enroll.ts).
export class HubDeviceEnrolledElsewhereError extends Schema.TaggedError<HubDeviceEnrolledElsewhereError>()(
  "HubDeviceEnrolledElsewhereError",
  {},
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return "This device is enrolled under a different account. Remove it there first.";
  }
}

// Every one of the account's MAX_ACCOUNT_DEVICES devices is online, so
// enrolling one more has none to make room by dropping.
export class HubAccountFullError extends Schema.TaggedError<HubAccountFullError>()(
  "HubAccountFullError",
  { limit: Schema.Int },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `This account already has ${this.limit} devices online. Remove one from the account page first.`;
  }
}

// The device a revoke or a change names is not one of the caller's
// account, which reads the same as one that does not exist.
export class HubUnknownDeviceError extends Schema.TaggedError<HubUnknownDeviceError>()(
  "HubUnknownDeviceError",
  { deviceId: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return "The device hub knows no such device on this account.";
  }
}

// A step behind the route failed: the account's hub object, its
// storage, or the Cloudflare API behind a tunnel. Worth a retry.
export class HubUnavailableError extends Schema.TaggedError<HubUnavailableError>()(
  "HubUnavailableError",
  {
    operation: Schema.Literals([
      "enroll",
      "list",
      "revoke",
      "update",
      "ticket",
      "tunnel",
    ]),
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    return `The device hub could not complete the ${this.operation} request.`;
  }
}

// The Worker runs without its ticket signing secret, so no device can
// connect until the owner sets it (hub/README.md, Deploy).
export class HubTicketSigningUnconfiguredError extends Schema.TaggedError<HubTicketSigningUnconfiguredError>()(
  "HubTicketSigningUnconfiguredError",
  {},
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return "The device hub has no ticket signing key configured.";
  }
}

// The Worker runs without the Cloudflare tunnel env: a deployment fact,
// not a failure. The tunnel runner reads it as "tunnels off".
export class HubTunnelUnconfiguredError extends Schema.TaggedError<HubTunnelUnconfiguredError>()(
  "HubTunnelUnconfiguredError",
  {},
  { httpApiStatus: 501 },
) {
  override get message(): string {
    return "Tunnel provisioning is not configured on the device hub.";
  }
}

// A connect ticket that is malformed or was not signed by this Worker,
// refused before any Durable Object is named. Everything past that
// (unknown, expired, replayed) is a close code after the upgrade.
export class HubTicketMalformedError extends Schema.TaggedError<HubTicketMalformedError>()(
  "HubTicketMalformedError",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "The device hub refused a malformed connect ticket.";
  }
}

// GET /connect without a websocket upgrade.
export class HubUpgradeRequiredError extends Schema.TaggedError<HubUpgradeRequiredError>()(
  "HubUpgradeRequiredError",
  {},
  { httpApiStatus: 426 },
) {
  override get message(): string {
    return "The device hub's connect route takes a websocket upgrade.";
  }
}

// ---- The version floor ----

// The oldest protocol the hub serves. A build below it, every v2 build
// included (they send no version at all), is turned away from every
// credentialed route. The connect route needs no check of its own: its
// ticket comes from a mint, which the floor already guards.
export const HUB_PROTOCOL_FLOOR = PROTOCOL_VERSION;

// The request header a build names its PROTOCOL_VERSION in.
export const PROTOCOL_HEADER = "sm-protocol";

// This build is older than the hub serves. `error` is the sentence a v2
// build reads out of a refusal body and shows (it knows no tags), so
// the one wording reaches every build. A 403 because v2 treats one as
// terminal until the account changes, rather than retrying forever.
export class HubUpdateRequiredError extends Schema.TaggedError<HubUpdateRequiredError>()(
  "HubUpdateRequiredError",
  { floor: Schema.Int, error: Schema.String },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return this.error;
  }
}

export class ProtocolFloor extends HttpApiMiddleware.Service<ProtocolFloor>()(
  "sm/contracts/ProtocolFloor",
  { error: HubUpdateRequiredError },
) {}

// The refusals a caller treats as the hub not honoring its credential,
// terminal until the account changes: a retry cannot turn one into a
// success.
export const isHubRefusal = Schema.is(
  Schema.Union([
    HubLoginRejectedError,
    HubCredentialRejectedError,
    HubDeviceRevokedError,
    HubUpdateRequiredError,
  ]),
);

export const isHubDeviceRevoked = Schema.is(HubDeviceRevokedError);

// ---- Auth tiers ----

// The account a verified Clerk session token belongs to.
export class HubLogin extends Context.Service<
  HubLogin,
  { readonly accountId: string }
>()("sm/contracts/HubLogin") {}

export class LoginAuth extends HttpApiMiddleware.Service<
  LoginAuth,
  { provides: HubLogin }
>()("sm/contracts/LoginAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  error: HubLoginRejectedError,
}) {}

// The enrolled device a credential belongs to, its account, and its
// kind: a browser profile is a web device, which holds a connection
// per tab, and anything else a desktop, which holds one.
export class HubDevice extends Context.Service<
  HubDevice,
  {
    readonly deviceId: string;
    readonly accountId: string;
    readonly kind: DeviceKind;
  }
>()("sm/contracts/HubDevice") {}

export class DeviceAuth extends HttpApiMiddleware.Service<
  DeviceAuth,
  { provides: HubDevice }
>()("sm/contracts/DeviceAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  error: [HubCredentialRejectedError, HubDeviceRevokedError],
}) {}

// ---- Routes ----

// A device rides as the Worker stored it, its icon whatever string the
// device sent. Each reader maps it to the catalog it knows by decoding
// it with DeviceInfoSchema (hubProtocol.ts), so a newer device's icon
// reaches an older app as the shape its platform is drawn as.
const EnrollResponseWire = Schema.toEncoded(EnrollResponseSchema);
const DeviceListResponseWire = Schema.toEncoded(DeviceListResponseSchema);

const enrollment = HttpApiGroup.make("enrollment", { topLevel: true }).add(
  // Re-enrolling the same device id rotates its credential, so exactly
  // one credential per device is valid at a time. A full account makes
  // room by dropping its stalest offline device.
  HttpApiEndpoint.post("enroll", "/devices/enroll", {
    payload: EnrollRequestSchema,
    success: EnrollResponseWire,
    error: [
      HubDeviceEnrolledElsewhereError,
      HubAccountFullError,
      HubUnavailableError,
    ],
  })
    .middleware(LoginAuth)
    .middleware(ProtocolFloor),
);

const devices = HttpApiGroup.make("devices", { topLevel: true })
  .add(
    HttpApiEndpoint.get("listDevices", "/devices", {
      success: DeviceListResponseWire,
      error: HubUnavailableError,
    }),
    // Any device of the account may revoke any device of it, itself
    // included.
    HttpApiEndpoint.delete("revokeDevice", "/devices/:deviceId", {
      params: { deviceId: DeviceIdSchema },
      error: [HubUnknownDeviceError, HubUnavailableError],
    }),
    // A device's name, its icon, or both, from any device of the
    // account. The changed device takes the new value from its next
    // registry read (shared/account/enroll.ts).
    HttpApiEndpoint.patch("updateDevice", "/devices/:deviceId", {
      params: { deviceId: DeviceIdSchema },
      payload: DevicePatchRequestSchema,
      error: [HubUnknownDeviceError, HubUnavailableError],
    }),
    // A ticket for one connection, named by the id its dialer minted
    // once and keeps across redials, so a redial replaces its own stale
    // socket and, on a web device, no other tab's.
    HttpApiEndpoint.post("mintTicket", "/tickets", {
      payload: Schema.Struct({ connectionId: HexId32Schema }),
      success: TicketResponseSchema,
      error: [HubTicketSigningUnconfiguredError, HubUnavailableError],
    }),
    // Creates or reuses this device's named Cloudflare tunnel, points its
    // ingress at the given loopback port and answers with the public
    // hostname and the connector run token.
    HttpApiEndpoint.post("provisionTunnel", "/tunnel", {
      payload: TunnelProvisionRequestSchema,
      success: TunnelProvisionResponseSchema,
      error: [HubTunnelUnconfiguredError, HubUnavailableError],
    }),
  )
  .middleware(DeviceAuth)
  .middleware(ProtocolFloor);

// The device's socket to its account's Durable Object. The upgrade
// succeeds for every ticket this Worker signed, and a ticket the
// object refuses (unknown, expired, replayed) closes with
// CLOSE_TICKET_REJECTED, since a browser's websocket shows a close code
// and hides an HTTP status.
const socket = HttpApiGroup.make("socket", { topLevel: true }).add(
  HttpApiEndpoint.get("connect", "/connect", {
    // Optional so a dial with none gets the malformed refusal, not a
    // bare 400.
    query: { ticket: Schema.optional(Schema.String) },
    success: HttpApiSchema.Empty(101),
    error: [HubTicketMalformedError, HubUpgradeRequiredError],
  }),
);

export class HubApi extends HttpApi.make("hub")
  .add(enrollment)
  .add(devices)
  .add(socket) {}
