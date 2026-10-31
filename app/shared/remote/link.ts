// The device link's limits and timings, which the host (host/socket/)
// and the dialers (shared/remote/deviceLink.ts, the web client) keep to.
// The link's group, its middleware and the peer a handler serves are
// the contracts' (@shigomori/contracts/link), which the terminal `sm`
// dials the loopback with too. Every frame is in Effect's binary layout
// (RpcSerialization.layerSchemaBinary) on both ends, so bytes cross as
// bytes.

// How long a dial's handshake may take, from the socket opening to the
// welcome checked.
export const HELLO_TIMEOUT_MS = 10_000;

// Liveness. A websocket over a NAT, a tunnel edge or a laptop that just
// slept can die without either end seeing a close. The dialer pings on
// this interval. A ping unanswered for the timeout is followed by a
// fresh probe, and the link is given up when that goes unanswered for
// PROBE_TIMEOUT_MS (packages/engine/src/liveness.ts), which hands the
// keeper a drop to redial on. A wake from sleep or a tab coming back
// sends a fresh probe at once instead of waiting out the interval.
export const PING_INTERVAL_MS = 15_000;
export const PING_TIMEOUT_MS = 40_000;
export const PROBE_TIMEOUT_MS = 5_000;

// The host's side of the same rule: a peer silent this long is cut off,
// so a dead socket does not hold its slot. Generous next to the
// dialer's timeout: a hidden browser tab pings once a minute under
// timer throttling.
export const HOST_LIVENESS_TIMEOUT_MS = 120_000;

// Byte channels one link may hold at once. A sanity bound against a
// runaway client, carved up on the dialing side between the forwards
// (host/portForward/engine.ts) and the mirror streams
// (host/mirror/MirrorGateway.ts).
export const MAX_CHANNELS_PER_LINK = 32;
