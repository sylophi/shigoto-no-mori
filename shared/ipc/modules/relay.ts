import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import type { SupervisorStatus } from "@shared/remote/supervisor";

// The renderer's bridge onto the main-process relay socket (v2 step 4,
// slice C). The single relay socket lives in main, because the Durable
// Object supersedes a duplicate socket per deviceId, so the renderer
// reaches remote peers by forwarding through main. Client-scoped on
// purpose: these calls are about THIS instance's relay socket, and the
// scope keeps every channel structurally off both remote wires
// (main/ipc/register.ts mounts client contracts on the Electron
// binding only), so the bridge can never be served back to a peer.

// Mirror of the shared supervisor's SupervisorStatus, as a schema so
// the bridge validates what crosses the Electron wire. On "connected"
// the remote identity fields are empty strings: the relay socket has
// no sm welcome of its own.
export const RelaySocketStatusSchema = z.discriminatedUnion("phase", [
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
// `never` on drift, applied to the exported RelayStatus below so it is
// referenced and its collapse surfaces at build time.
type SocketStatusMatchesSupervisor =
  z.infer<typeof RelaySocketStatusSchema> extends SupervisorStatus
    ? SupervisorStatus extends z.infer<typeof RelaySocketStatusSchema>
      ? unknown
      : never
    : never;

export const RelayStatusSchema = z.object({
  socket: RelaySocketStatusSchema,
  // The account's online deviceIds from the latest presence broadcast,
  // empty whenever the socket is down.
  onlineDeviceIds: z.array(z.string()),
  // The appVersion each currently connected client peer confirmed in its
  // welcome, keyed by deviceId. Empty for a peer with no open session,
  // so the renderer reads it here instead of polling peerInfo per device.
  peerAppVersions: z.record(z.string(), z.string()),
});
export type RelayStatus = z.infer<typeof RelayStatusSchema> &
  SocketStatusMatchesSupervisor;

// A push frame received from a peer, fanned out to every window. The
// renderer filters by deviceId and channel, so main forwards every
// push wholesale and needs no per-channel subscription bookkeeping.
export const RelayPeerPushSchema = z.object({
  deviceId: z.string(),
  channel: z.string(),
  payload: z.unknown().optional(),
});
export type RelayPeerPush = z.infer<typeof RelayPeerPushSchema>;

export const relayContract = defineContract("client", {
  // The current socket phase plus the online set. Cheap: main reads
  // its in-memory snapshot, nothing touches the network.
  status: invoke("relay:status", z.void(), RelayStatusSchema),
  // Forward one sm invoke to a peer device over the relay. Main opens
  // the peer session lazily on first use and caches it. Offline,
  // oversize and disconnected surface as thrown errors whose messages
  // ride Electron's error serialization.
  invokePeer: invoke(
    "relay:invokePeer",
    z.object({
      // Bounded like RelaySendEnvelopeSchema.to, since it is routed to a
      // peer session keyed by this id (M6).
      deviceId: z.string().min(1).max(200),
      channel: z.string().min(1),
      input: z.unknown().optional(),
    }),
    z.unknown(),
  ),
  // The cached peer connection's identity, or null when no session is
  // open. Deliberately does not dial: the first real invoke opens the
  // session, and this only reports what the hello already confirmed.
  peerInfo: invoke(
    "relay:peerInfo",
    z.object({ deviceId: z.string().min(1).max(200) }),
    z.object({ appVersion: z.string() }).nullable(),
  ),
  // Fan-out on every supervisor or presence transition, carrying the
  // fresh snapshot so listeners never need a follow-up status call.
  statusChanged: broadcast("relay:statusChanged", RelayStatusSchema),
  // Fan-out of every push frame received from any peer, see
  // RelayPeerPushSchema.
  peerPush: broadcast("relay:peerPush", RelayPeerPushSchema),
});
