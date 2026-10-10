import * as Schema from "effect/Schema";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { broadcast, defineContract, invoke, view } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

// The renderer's bridge onto this machine's hub socket. The single hub
// socket lives in the host, because the Durable Object supersedes a
// duplicate socket per deviceId, so the renderer reaches remote peers
// by forwarding through the host. Client-scoped on purpose: these calls
// are about THIS instance's hub socket, and the scope keeps every
// channel structurally off the device link (LinkGroup takes only
// remote calls), so the bridge can never be served back to a peer.

// A connection's status: the shared supervisor's SupervisorStatus is
// this schema's type, and the bridge validates what crosses the
// loopback with it. On "connected" the remote identity fields are
// empty strings: the hub socket has no sm welcome of its own.
const HubSocketStatusSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("idle") }),
  Schema.Struct({ phase: Schema.Literal("connecting") }),
  Schema.Struct({
    phase: Schema.Literal("connected"),
    remoteDeviceId: Schema.String,
    remoteAppVersion: Schema.String,
  }),
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

// THIS device's tunnel endpoint state vocabulary. The wire schema is the single owner: the cloudflared runner
// (host/direct/cloudflared.ts) types its state off this so the two
// sides cannot drift.
const TunnelStateSchema = Schema.Literals([
  "off",
  "no-binary",
  "unconfigured",
  "starting",
  "up",
  "error",
]);
export type TunnelState = typeof TunnelStateSchema.Type;

// Despite the module name, HubStatus is the REMOTE-PLANE snapshot: the
// hub control plane's socket and roster plus the direct data plane it
// brokers (sessions, versions, the tunnel endpoint). The device hub
// itself carries orchestration only, so every
// per-peer data fact below is about direct sessions.
const HubStatusSchema = Schema.Struct({
  socket: HubSocketStatusSchema,
  // The account's online deviceIds from the latest presence broadcast,
  // empty whenever the socket is down. A roster fact only: online
  // means enrolled and connected to the device hub, not data-reachable.
  onlineDeviceIds: Schema.Array(Schema.String),
  // The appVersion each ESTABLISHED direct session's welcome
  // confirmed, keyed by deviceId. Absent key means no direct session,
  // so membership here is the whole "direct-connected" surface (the
  // only kind of data session there is) and the
  // renderer reads it instead of polling peerInfo per device.
  peerAppVersions: Schema.Record(Schema.String, Schema.String),
  // Whether each of those peers runs THIS device's commands (its
  // command-access switch), keyed the same way: the peer's connectInfo
  // answer at dial time, then its account:commandAccessChanged push.
  // The renderer's read-only notes and the CLI's no-grant standing
  // read it here instead of asking the peer. The peer's CommandGate
  // is still what enforces it.
  peerAcceptsCommands: Schema.Record(Schema.String, Schema.Boolean),
  // Whether each of those peers shares with THIS device at all (its
  // sharing switch), keyed and kept the same way, from its
  // sharing:changed push. Off, the peer serves nothing, so the renderer
  // shows it as not sharing and the CLI as not-sharing.
  peerSharesData: Schema.Record(Schema.String, Schema.Boolean),
  // The tunnel endpoint state, for the account page. Optional because
  // only a serving side with a host half sets it (the web bridge runs
  // no cloudflared). Not a skew concern: hub:status is
  // client-scoped, this machine's host answering its own windows, so
  // both ends are always the same build. Never carries the hostname or
  // any secret.
  tunnel: Schema.optional(TunnelStateSchema),
});
// How long a freshly provisioned tunnel is probed before the host
// gives up and re-provisions (host/direct/cloudflared.ts): its DNS
// record is new and may take this long to route. Shared so the
// registry's "tunnel starting" note quotes the same figure.
export const TUNNEL_PROBE_DEADLINE_FRESH_MS = 45 * 60_000;

export type HubStatus = typeof HubStatusSchema.Type;

// A push frame received from a peer, fanned out to every window. The
// renderer filters by deviceId and channel, so the host forwards every

// push wholesale and needs no per-channel subscription bookkeeping.
const HubPeerPushSchema = Schema.Struct({
  deviceId: Schema.String,
  channel: Schema.String,
  payload: Schema.optional(Schema.Unknown),
});
export type HubPeerPush = typeof HubPeerPushSchema.Type;

export const hubContract = defineContract(
  "hub",
  "client",
  // The remote-plane snapshot (HubStatusSchema above): the hub
  // socket's phase and roster plus the direct sessions and tunnel
  // state. Cheap: the host reads its in-memory snapshot, nothing touches
  // the network.
  invoke("status", VoidSchema, HubStatusSchema),
  // Forward one sm invoke to a peer device over its DIRECT session.
  // Sessions are supervised desired state (shared/hub/directKeeper.ts):
  // the owner dials every rostered peer eagerly and redials forever,
  // so this NEVER dials -- it rides the session the keeper holds
  // (joining an in-flight dial), and with none it rejects at once with
  // the keeper's last failure folded in. Errors ride each wire's error
  // serialization.
  invoke(
    "invokePeer",
    Schema.Struct({
      // Routed to a peer session keyed by this id, so it carries the
      // shared device-id bound.
      deviceId: DeviceIdSchema,
      channel: Schema.NonEmptyString,
      input: Schema.optional(Schema.Unknown),
    }),
    // A void call's answer is undefined, which the binary layout carries
    // only as its own arm: Unknown alone is JSON there.
    Schema.UndefinedOr(Schema.Unknown),
  ),
  // A peer's view (a terminal's attach) through the same session, its
  // values as the peer sends them, which the caller decodes as the
  // view's.
  view(
    "watchPeer",
    Schema.Struct({
      deviceId: DeviceIdSchema,
      channel: Schema.NonEmptyString,
      input: Schema.optional(Schema.Unknown),
    }),
    Schema.Unknown,
  ),
  // Fan-out on every supervisor or presence transition, carrying the
  // fresh snapshot so listeners never need a follow-up status call.
  broadcast("statusChanged", HubStatusSchema),
  // Fan-out of every push frame received from any peer, see
  // HubPeerPushSchema.
  broadcast("peerPush", HubPeerPushSchema),
);
