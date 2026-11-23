import * as Schema from "effect/Schema";
import { OutdatedSideSchema } from "../errors.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { push, defineContract, invoke, view } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

// The device (@colibrii/sdk) lives with the bridge, in the host or in
// the web client's page, so windows reach peers through it.
// Client-scoped, so the bridge can never be served back to a peer.

// This device's hub socket. Blocked is what a person must act on: the
// device was removed from the account, another copy of it took over, its
// credential was replaced, or the service wants a newer build.
const HubSocketStatusSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("stopped") }),
  Schema.Struct({ phase: Schema.Literal("connecting") }),
  Schema.Struct({ phase: Schema.Literal("connected") }),
  Schema.Struct({
    phase: Schema.Literal("blocked"),
    reason: Schema.Literals([
      "revoked",
      "superseded",
      "refused",
      "update-required",
    ]),
    message: Schema.String,
  }),
]);
export type HubSocketStatus = typeof HubSocketStatusSchema.Type;

// The account let this device go, which the window's Clerk session
// follows it out on.
export const credentialRevoked = (status: HubSocketStatus): boolean =>
  status.phase === "blocked" && status.reason === "revoked";

// off: not listening (opted out, signed out). no-binary: no usable
// cloudflared. starting: provisioning, spawning or waiting for the
// hostname to route. up: routes, and is offered. error: the last run
// failed, and a restart is due.
const TunnelStateSchema = Schema.Literals([
  "off",
  "no-binary",
  "starting",
  "up",
  "error",
]);
export type TunnelState = typeof TunnelStateSchema.Type;

// The hub socket and roster plus the direct sessions it brokers. Every
// per-peer fact is about a direct session.
const HubStatusSchema = Schema.Struct({
  socket: HubSocketStatusSchema,
  // Connected to the hub, not data-reachable.
  onlineDeviceIds: Schema.Array(Schema.String),
  // A key is present exactly while a direct session is.
  peerAppVersions: Schema.Record(Schema.String, Schema.String),
  // Each peer's command switch, for display. Its CommandGate is what
  // enforces it.
  peerAcceptsCommands: Schema.Record(Schema.String, Schema.Boolean),
  peerSharesData: Schema.Record(Schema.String, Schema.Boolean),
  // The peers on another release of the app. One with a session has
  // the modules its link refuses this device's calls into (link.ts,
  // outdatedModules), and one on another core (protocol.ts), which no
  // session lands with, is in peerCoreOutdated. Each with the end on
  // the older build.
  peerOutdated: Schema.Record(
    Schema.String,
    Schema.Struct({
      outdated: OutdatedSideSchema,
      modules: Schema.Array(Schema.String),
    }),
  ),
  peerCoreOutdated: Schema.Record(Schema.String, OutdatedSideSchema),
  // Absent on the web client, which runs no cloudflared.
  tunnel: Schema.optional(TunnelStateSchema),
});

export type HubStatus = typeof HubStatusSchema.Type;

// Forwarded wholesale, and windows filter by device and channel.
const HubPeerPushSchema = Schema.Struct({
  deviceId: Schema.String,
  channel: Schema.String,
  payload: Schema.optional(Schema.Unknown),
});
export type HubPeerPush = typeof HubPeerPushSchema.Type;

export const hubContract = defineContract(
  "hub",
  "client",
  // In memory, nothing touches the network.
  invoke("status", VoidSchema, HubStatusSchema),
  // Never dials: it rides the session the keeper holds (joining one in
  // flight), and with none rejects at once with the keeper's last
  // failure.
  invoke(
    "invokePeer",
    Schema.Struct({
      deviceId: DeviceIdSchema,
      channel: Schema.NonEmptyString,
      input: Schema.optional(Schema.Unknown),
    }),
    // The binary layout carries undefined only as its own arm: Unknown
    // alone is JSON there.
    Schema.UndefinedOr(Schema.Unknown),
  ),
  // The values arrive decoded by the RPC client holding the session.
  view(
    "watchPeer",
    Schema.Struct({
      deviceId: DeviceIdSchema,
      channel: Schema.NonEmptyString,
      input: Schema.optional(Schema.Unknown),
    }),
    Schema.Unknown,
  ),
  push("statusChanged", HubStatusSchema),
  push("peerPush", HubPeerPushSchema),
);
