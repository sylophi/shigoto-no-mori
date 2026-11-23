// The link's limits and timings, which the host (host/socket/) and the
// dialers (shared/remote/deviceLink.ts, the web client) keep to. The
// link's group, its middleware and the peer a handler serves are the
// contracts' (@shigomori/contracts/link), which the terminal `sm` dials
// the loopback with too. Every frame is in Effect's binary layout
// (RpcSerialization.layerSchemaBinary) on both ends, so bytes cross as
// bytes.

// How long a loopback socket has to say hello.
export const HELLO_TIMEOUT_MS = 10_000;

// Byte channels one link may hold at once. A sanity bound against a
// runaway client, carved up on the dialing side between the forwards
// (host/portForward/engine.ts) and the mirror streams
// (host/mirror/MirrorGateway.ts).
export const MAX_CHANNELS_PER_LINK = 32;

// How long an ask that only informs an answer waits on a peer (the
// terminal's device listings, host/lib/control/peers.ts).
export const PROBE_TIMEOUT_MS = 5_000;
