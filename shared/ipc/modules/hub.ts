import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { DeviceIdSchema } from "@shared/hub/protocol";
import type { SupervisorStatus } from "@shared/remote/supervisor";

// The renderer's bridge onto the main-process hub socket (v2 step 4,
// slice C). The single hub socket lives in main, because the Durable
// Object supersedes a duplicate socket per deviceId, so the renderer
// reaches remote peers by forwarding through main. Client-scoped on
// purpose: these calls are about THIS instance's hub socket, and the
// scope keeps every channel structurally off both remote wires
// (main/ipc/register.ts mounts client contracts on the Electron
// binding only), so the bridge can never be served back to a peer.

// Mirror of the shared supervisor's SupervisorStatus, as a schema so
// the bridge validates what crosses the Electron wire. On "connected"
// the remote identity fields are empty strings: the hub socket has
// no sm welcome of its own.
export const HubSocketStatusSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }),
  z.object({ phase: z.literal("connecting") }),
  z.object({
    phase: z.literal("connected"),
    remoteDeviceId: z.string(),
    remoteAppVersion: z.string(),
  }),
  z.object({
    phase: z.literal("backoff"),
    attempt: z.number().int(),
    delayMs: z.number(),
  }),
  z.object({ phase: z.literal("blocked"), message: z.string() }),
  z.object({ phase: z.literal("stopped") }),
]);

// Compile-time pin (Q3): the wire schema must infer exactly the
// supervisor's status union, both directions, so a new phase added to
// one side without the other is a build error here rather than a runtime
// schema miss. `unknown` on a match (intersecting away to nothing) and
// `never` on drift, applied to the exported HubStatus below so it is
// referenced and its collapse surfaces at build time.
type SocketStatusMatchesSupervisor =
  z.infer<typeof HubSocketStatusSchema> extends SupervisorStatus
    ? SupervisorStatus extends z.infer<typeof HubSocketStatusSchema>
      ? unknown
      : never
    : never;

// THIS device's tunnel endpoint state vocabulary (v2 step 10, slice
// B). The wire schema is the single owner: the cloudflared runner
// (host/direct/cloudflared.ts) types its state off this so the two
// sides cannot drift.
export const TunnelStateSchema = z.enum([
  "off",
  "no-binary",
  "unconfigured",
  "starting",
  "up",
  "error",
]);
export type TunnelState = z.infer<typeof TunnelStateSchema>;

// Despite the module name, HubStatus is the REMOTE-PLANE snapshot: the
// hub control plane's socket and roster plus the direct data plane it
// brokers (sessions, versions, the tunnel endpoint). The device hub
// itself carries orchestration only (v2 step 10, slice C), so every
// per-peer data fact below is about direct sessions.
export const HubStatusSchema = z.object({
  socket: HubSocketStatusSchema,
  // The account's online deviceIds from the latest presence broadcast,
  // empty whenever the socket is down. A roster fact only: online
  // means enrolled and connected to the device hub, not data-reachable.
  onlineDeviceIds: z.array(z.string()),
  // The appVersion each ESTABLISHED direct session's welcome
  // confirmed, keyed by deviceId. Absent key means no direct session,
  // so membership here is the whole "direct-connected" surface (the
  // only kind of data session there is, v2 step 10 slice C) and the
  // renderer reads it instead of polling peerInfo per device.
  peerAppVersions: z.record(z.string(), z.string()),
  // The tunnel endpoint state, for the devices page. Optional because
  // only a serving side with a host half sets it (the web bridge runs
  // no cloudflared). Not a skew concern: hub:status is
  // client-scoped, main answering its own renderer, so both ends are
  // always the same build. Never carries the hostname or any secret.
  tunnel: TunnelStateSchema.optional(),
});
export type HubStatus = z.infer<typeof HubStatusSchema> &
  SocketStatusMatchesSupervisor;

// A push frame received from a peer, fanned out to every window. The
// renderer filters by deviceId and channel, so main forwards every
// push wholesale and needs no per-channel subscription bookkeeping.
export const HubPeerPushSchema = z.object({
  deviceId: z.string(),
  channel: z.string(),
  payload: z.unknown().optional(),
});
export type HubPeerPush = z.infer<typeof HubPeerPushSchema>;

export const hubContract = defineContract("client", {
  // The current socket phase plus the online set. Cheap: main reads
  // its in-memory snapshot, nothing touches the network.
  status: invoke("hub:status", z.void(), HubStatusSchema),
  // Forward one sm invoke to a peer device over its DIRECT session.
  // Sessions are supervised desired state (shared/hub/directKeeper.ts):
  // the owner dials every rostered peer eagerly and redials forever,
  // so this NEVER dials -- it rides the session the keeper holds
  // (joining an in-flight dial), and with none it rejects at once with
  // the keeper's last failure folded in. Errors ride each wire's error
  // serialization.
  invokePeer: invoke(
    "hub:invokePeer",
    z.object({
      // Routed to a peer session keyed by this id (M6), so it carries the
      // shared device-id bound.
      deviceId: DeviceIdSchema,
      channel: z.string().min(1),
      input: z.unknown().optional(),
    }),
    z.unknown(),
  ),
  // Fan-out on every supervisor or presence transition, carrying the
  // fresh snapshot so listeners never need a follow-up status call.
  statusChanged: broadcast("hub:statusChanged", HubStatusSchema),
  // Fan-out of every push frame received from any peer, see
  // HubPeerPushSchema.
  peerPush: broadcast("hub:peerPush", HubPeerPushSchema),
});
