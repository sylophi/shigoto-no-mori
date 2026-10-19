// Enrolling takes a Clerk session token, every other route the device
// credential. The only secret allowed in a URL is the single-use ticket
// on GET /connect, since a websocket client can't set headers.
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
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

export class HubLoginRejectedError extends Schema.TaggedError<HubLoginRejectedError>()(
  "HubLoginRejectedError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "The device hub did not accept this sign-in.";
  }
}

export class HubCredentialRejectedError extends Schema.TaggedError<HubCredentialRejectedError>()(
  "HubCredentialRejectedError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "The device hub no longer accepts this device's credential.";
  }
}

// The one refusal the app signs out on. The socket's close code only
// reaches a device online at the revoke.
export class HubDeviceRevokedError extends Schema.TaggedError<HubDeviceRevokedError>()(
  "HubDeviceRevokedError",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "This device was removed from the account.";
  }
}

// Left by a sign-out whose revoke never reached the hub.
export class HubDeviceEnrolledElsewhereError extends Schema.TaggedError<HubDeviceEnrolledElsewhereError>()(
  "HubDeviceEnrolledElsewhereError",
  {},
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return "This device is enrolled under a different account. Remove it there first.";
  }
}

// Every device is online, so none can be dropped to make room.
export class HubAccountFullError extends Schema.TaggedError<HubAccountFullError>()(
  "HubAccountFullError",
  { limit: Schema.Int },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `This account already has ${this.limit} devices online. Remove one from the account page first.`;
  }
}

// Another account's device reads the same as one that doesn't exist.
export class HubUnknownDeviceError extends Schema.TaggedError<HubUnknownDeviceError>()(
  "HubUnknownDeviceError",
  { deviceId: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return "The device hub knows no such device on this account.";
  }
}

// Worth a retry.
export class HubUnavailableError extends Schema.TaggedError<HubUnavailableError>()(
  "HubUnavailableError",
  {
    operation: Schema.Literals([
      "enroll",
      "credential",
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
    return this.operation === "credential"
      ? "The device hub could not check this device's credential."
      : `The device hub could not complete the ${this.operation} request.`;
  }
}

export class HubTicketSigningUnconfiguredError extends Schema.TaggedError<HubTicketSigningUnconfiguredError>()(
  "HubTicketSigningUnconfiguredError",
  {},
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return "The device hub has no ticket signing key configured.";
  }
}

// A deployment fact, not a failure: read as "tunnels off".
export class HubTunnelUnconfiguredError extends Schema.TaggedError<HubTunnelUnconfiguredError>()(
  "HubTunnelUnconfiguredError",
  {},
  { httpApiStatus: 501 },
) {
  override get message(): string {
    return "Tunnel provisioning is not configured on the device hub.";
  }
}

// Refused before any Durable Object is named. Unknown, expired and
// replayed tickets are a close code after the upgrade.
export class HubTicketMalformedError extends Schema.TaggedError<HubTicketMalformedError>()(
  "HubTicketMalformedError",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "The device hub refused a malformed connect ticket.";
  }
}

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

// v2 builds send no version at all. The connect route needs no check of
// its own: its ticket comes from a mint, which the floor guards.
export const HUB_PROTOCOL_FLOOR = PROTOCOL_VERSION;

export const PROTOCOL_HEADER = "sm-protocol";

// `error` is the sentence a v2 build shows (it knows no tags). A 403,
// which v2 treats as terminal rather than retrying forever.
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

// Terminal until the account changes: a retry can't succeed.
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

export class HubLogin extends Context.Service<
  HubLogin,
  { readonly accountId: string }
>()("sm/contracts/HubLogin") {}

export class LoginAuth extends HttpApiMiddleware.Service<
  LoginAuth,
  { provides: HubLogin }
>()("sm/contracts/LoginAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  // Unavailable when the sign-in could not be checked at all (Clerk
  // unreachable), which a retry may clear.
  error: [HubLoginRejectedError, HubUnavailableError],
}) {}

// credentialHash: what the tickets it mints are bound to.
export class HubDevice extends Context.Service<
  HubDevice,
  {
    readonly deviceId: string;
    readonly accountId: string;
    readonly credentialHash: string;
  }
>()("sm/contracts/HubDevice") {}

export class DeviceAuth extends HttpApiMiddleware.Service<
  DeviceAuth,
  { provides: HubDevice }
>()("sm/contracts/DeviceAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  error: [
    HubCredentialRejectedError,
    HubDeviceRevokedError,
    HubUnavailableError,
  ],
}) {}

// ---- Routes ----

// As the Worker stored it: each reader maps the icon to the catalog it
// knows (DeviceInfoSchema).
const EnrollResponseWire = Schema.toEncoded(EnrollResponseSchema);
const DeviceListResponseWire = Schema.toEncoded(DeviceListResponseSchema);

const enrollment = HttpApiGroup.make("enrollment", { topLevel: true }).add(
  // Re-enrolling rotates the credential. A full account drops its
  // stalest offline device.
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
    HttpApiEndpoint.delete("revokeDevice", "/devices/:deviceId", {
      params: { deviceId: DeviceIdSchema },
      error: [HubUnknownDeviceError, HubUnavailableError],
    }),
    HttpApiEndpoint.patch("updateDevice", "/devices/:deviceId", {
      params: { deviceId: DeviceIdSchema },
      payload: DevicePatchRequestSchema,
      error: [HubUnknownDeviceError, HubUnavailableError],
    }),
    // connectionId is kept across redials, so a redial replaces its own
    // stale socket and no other tab's.
    HttpApiEndpoint.post("mintTicket", "/tickets", {
      payload: Schema.Struct({ connectionId: HexId32Schema }),
      success: TicketResponseSchema,
      error: [HubTicketSigningUnconfiguredError, HubUnavailableError],
    }),
    HttpApiEndpoint.post("provisionTunnel", "/tunnel", {
      payload: TunnelProvisionRequestSchema,
      success: TunnelProvisionResponseSchema,
      error: [HubTunnelUnconfiguredError, HubUnavailableError],
    }),
  )
  .middleware(DeviceAuth)
  .middleware(ProtocolFloor);

// A ticket the object refuses closes with CLOSE_TICKET_REJECTED after
// the upgrade: a browser's websocket shows a close code and hides an
// HTTP status.
const socket = HttpApiGroup.make("socket", { topLevel: true }).add(
  HttpApiEndpoint.get("connect", "/connect", {
    query: { ticket: Schema.optional(Schema.String) },
    success: HttpApiSchema.Empty(101),
    error: [HubTicketMalformedError, HubUpgradeRequiredError],
  }),
);

export class HubApi extends HttpApi.make("hub")
  .add(enrollment)
  .add(devices)
  .add(socket) {}
