import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { DeviceIdSchema } from "@shared/relay/protocol";
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

export const RelayStatusSchema = z.object({
  socket: RelaySocketStatusSchema,
  // The account's online deviceIds from the latest presence broadcast,
  // empty whenever the socket is down.
  onlineDeviceIds: z.array(z.string()),
  // The appVersion each currently connected client peer confirmed in its
  // welcome, keyed by deviceId. Empty for a peer with no open session,
  // so the renderer reads it here instead of polling peerInfo per device.
  peerAppVersions: z.record(z.string(), z.string()),
  // The peers whose cached session rides a DIRECT socket rather than
  // the relay (v2 step 10, slice A). Optional per the version-skew
  // policy: absent means the serving side predates the direct plane.
  directDeviceIds: z.array(z.string()).optional(),
  // The tunnel endpoint state, for the devices page. Additive-optional:
  // absent means the serving side predates tunnels (the web bridge,
  // which runs no cloudflared, never sets it). Never carries the
  // hostname or any secret.
  tunnel: TunnelStateSchema.optional(),
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
      // Routed to a peer session keyed by this id (M6), so it carries the
      // shared device-id bound.
      deviceId: DeviceIdSchema,
      channel: z.string().min(1),
      input: z.unknown().optional(),
    }),
    z.unknown(),
  ),
  // Ensure a peer session exists WITHOUT invoking anything (v2 step 6,
  // slice B): pushes only reach helloed sessions, so a subscribe-only
  // view must be able to open the session on its own instead of waiting
  // for a first invoke that may never come. The renderer's relay
  // transport calls this on subscribe, and again after a reconnect for
  // every device with live subscribers, so subscriptions survive a
  // relay socket drop. Resolves once the session is up. An offline peer
  // rejects and the caller retries on the next status change.
  ensurePeer: invoke(
    "relay:ensurePeer",
    z.object({ deviceId: DeviceIdSchema }),
    z.void(),
  ),
  // The cached peer connection's identity, or null when no session is
  // open. Deliberately does not dial: the first real invoke opens the
  // session, and this only reports what the hello already confirmed.
  peerInfo: invoke(
    "relay:peerInfo",
    z.object({ deviceId: DeviceIdSchema }),
    z.object({ appVersion: z.string() }).nullable(),
  ),
  // Fan-out on every supervisor or presence transition, carrying the
  // fresh snapshot so listeners never need a follow-up status call.
  statusChanged: broadcast("relay:statusChanged", RelayStatusSchema),
  // Fan-out of every push frame received from any peer, see
  // RelayPeerPushSchema.
  peerPush: broadcast("relay:peerPush", RelayPeerPushSchema),
});
