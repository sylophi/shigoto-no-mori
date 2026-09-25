// The client-side liveness heartbeat every long-lived socket runs (the
// direct sessions in wsClientTransport.ts, the hub socket in
// shared/hub/connection.ts). One owner for one subtle rule, so the two
// wires cannot drift on it:
//
// A ping goes out every interval. ANY inbound frame answers it (a res
// or push proves the peer alive as well as a pong does), and a ping
// still unanswered after the timeout means the socket is dead.
// `pingSentAt` is the OLDEST unanswered ping, so the verdict never
// depends on this side's own timer cadence: a throttled background tab
// that wakes once a minute measures from its last ping, not from an
// interval it could not keep. A probe (fired on a wake from sleep or a
// tab coming back) sends a ping now and judges within the short probe
// window instead of the heartbeat cadence, so a socket that died while
// we were away is found out in seconds.
//
// The owner supplies the wire's ping encoding and what a death does
// (close the socket without waiting on the platform's close handshake,
// which against a dead peer can take a browser a minute, and report
// through its close path so the supervisor or keeper redials).
// Browser-global code only: setInterval, setTimeout, Date.now.
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
} from "./frames";

// Test seams. Real callers take the frames.ts defaults.
export type HeartbeatOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  probeTimeoutMs?: number;
};

type Heartbeat = {
  // Arm the interval (once the socket is established).
  start(): void;
  // Cancel every timer. Idempotent, safe before start.
  stop(): void;
  // An inbound frame arrived: it answers the oldest unanswered ping.
  noteInbound(): void;
  // Send a ping now and judge within the probe window. A no-op while
  // not started, or while a probe is already pending.
  probe(): void;
};

// A timer must never be what keeps a node process alive (the checks
// run this code headlessly, and a leaked socket would hang them).
// Browsers hand back a number, which has no unref.
function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

export function createHeartbeat(
  deps: HeartbeatOptions & {
    // Writes one ping to the wire. May throw once the socket is
    // unusable. The close event that follows owns the outcome.
    sendPing(): void;
    onDead(): void;
  },
): Heartbeat {
  const intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  let pingSentAt: number | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  function stop(): void {
    started = false;
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }

  function declareDead(): void {
    stop();
    deps.onDead();
  }

  function sendPing(): void {
    try {
      deps.sendPing();
    } catch {
      return;
    }
    if (pingSentAt === null) pingSentAt = Date.now();
  }

  return {
    start() {
      if (started) return;
      started = true;
      intervalTimer = setInterval(() => {
        if (pingSentAt !== null) {
          if (Date.now() - pingSentAt >= timeoutMs) declareDead();
          return;
        }
        sendPing();
      }, intervalMs);
      unref(intervalTimer);
    },
    stop,
    noteInbound() {
      pingSentAt = null;
    },
    probe() {
      if (!started || probeTimer !== null) return;
      sendPing();
      const sentAt = Date.now();
      probeTimer = setTimeout(() => {
        probeTimer = null;
        // Any frame since the probe went out is the answer.
        if (pingSentAt !== null && pingSentAt <= sentAt) declareDead();
      }, probeTimeoutMs);
      unref(probeTimer);
    },
  };
}
