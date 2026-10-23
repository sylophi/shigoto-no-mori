import * as Schema from "effect/Schema";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { push, defineContract, invoke, view } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

// The hub socket lives with the bridge, in the host (one per desktop
// device: the Durable Object supersedes a second) or in the web shell's
// page, so windows reach peers through it.
// Client-scoped, so the bridge can never be served back to a peer.

const HubSocketStatusSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("idle") }),
  Schema.Struct({ phase: Schema.Literal("connecting") }),
  Schema.Struct({ phase: Schema.Literal("connected") }),
  Schema.Struct({
    phase: Schema.Literal("backoff"),
    attempt: Schema.Int,
    delayMs: Schema.Finite,
  }),
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
  Schema.Struct({ phase: Schema.Literal("stopped") }),
]);

// off: not wanted (listener down, opted out, signed out). no-binary:
// wanted, but no usable cloudflared. unconfigured: the Worker has no
// tunnel env. starting: provisioning, spawning or probing readiness.
// up: probed routable and advertised. error: the last attempt failed,
// and a restart is scheduled, or, for a denied provision, nothing
// retries until the next reconcile.
const TunnelStateSchema = Schema.Literals([
  "off",
  "no-binary",
  "unconfigured",
  "starting",
  "up",
  "error",
]);
export type TunnelState = typeof TunnelStateSchema.Type;

// The hub socket and roster plus the direct sessions it brokers; every
// per-peer fact is about a direct session.
const HubStatusSchema = Schema.Struct({
  socket: HubSocketStatusSchema,
  // Connected to the hub, not data-reachable.
  onlineDeviceIds: Schema.Array(Schema.String),
  // A key is present exactly while a direct session is.
  peerAppVersions: Schema.Record(Schema.String, Schema.String),
  // Each peer's command switch, for display; its CommandGate is what
  // enforces it.
  peerAcceptsCommands: Schema.Record(Schema.String, Schema.Boolean),
  peerSharesData: Schema.Record(Schema.String, Schema.Boolean),
  // Absent on the web client, which runs no cloudflared.
  tunnel: Schema.optional(TunnelStateSchema),
});

export type HubStatus = typeof HubStatusSchema.Type;

// Forwarded wholesale; windows filter by device and channel.
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
  // The caller decodes the values as the view's.
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
