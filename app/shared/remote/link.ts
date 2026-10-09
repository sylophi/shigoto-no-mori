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
// this interval and gives the link up when nothing has arrived for the
// timeout, which hands the keeper a drop to redial on. A probe (a wake
// from sleep, a tab coming back) asks for a verdict within
// PROBE_TIMEOUT_MS instead of waiting out the interval.
export const PING_INTERVAL_MS = 15_000;
export const PING_TIMEOUT_MS = 40_000;
export const PROBE_TIMEOUT_MS = 5_000;

// The host's side of the same rule: a peer silent this long is cut off,
// so a dead socket does not hold its slot. Generous next to the
// dialer's timeout: a hidden browser tab pings once a minute under
// timer throttling.
export const HOST_LIVENESS_TIMEOUT_MS = 120_000;

// Calls one peer may have running at once, its streams aside. Over it a
// call is refused rather than spawning yet another git or CLI process.
export const MAX_IN_FLIGHT_PER_PEER = 64;

// Byte channels one link may hold at once. A sanity bound against a
// runaway client, carved up on the dialing side between the forwards
// (host/portForward/engine.ts) and the mirror streams
// (host/mirror/gateway.ts).
export const MAX_CHANNELS_PER_LINK = 32;
