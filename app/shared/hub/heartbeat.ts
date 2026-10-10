// The hub socket's liveness heartbeat (shared/hub/connection.ts). The
// device link has its own in Effect RPC's pings (shared/remote/link.ts),
// and the hub socket, which is not an RPC link, keeps this one.
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
// The pings and the probe are fibers on Schedules, read against the
// Clock: browser-safe.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { PROBE_TIMEOUT_MS } from "@shared/remote/link";

// A websocket over a NAT, a tunnel edge or a laptop that just slept can
// die without either end seeing a close, so the client pings on this
// interval and gives the socket up when a ping stays unanswered for the
// timeout. The timeout runs from the oldest unanswered ping, never from
// the last frame, so a background tab whose timers the browser throttles
// is not misjudged dead by its own slow cadence.
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 40_000;

// Test seams. Real callers take the defaults.
export type HeartbeatOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  probeTimeoutMs?: number;
};

type Heartbeat = {
  // Arm the pings (once the socket is established).
  start(): void;
  // End the pings and any probe. Idempotent, safe before start.
  stop(): void;
  // An inbound frame arrived: it answers the oldest unanswered ping.
  noteInbound(): void;
  // Send a ping now and judge within the probe window. A no-op while
  // not started, or while a probe is already pending.
  probe(): void;
};

// The live clock with its sleeps unref'd: a heartbeat must never be what
// keeps a node process alive (the checks and the wire bench run this
// headlessly, and a leaked socket would hang them).
const live = Effect.runSync(Clock.clockWith(Effect.succeed));
const unrefClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
  currentTimeMillis: live.currentTimeMillis,
  currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
  currentTimeNanos: live.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) =>
    Effect.callback<void>((resume) => {
      const timer = setTimeout(
        () => resume(Effect.void),
        Duration.toMillis(duration),
      );
      // Browsers hand back a number, which has no unref.
      (timer as { unref?: () => void }).unref?.();
      return Effect.sync(() => clearTimeout(timer));
    }),
};

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
  const run = Effect.runForkWith(Context.make(Clock.Clock, unrefClock));

  let pingSentAt: number | null = null;
  let pings: Fiber.Fiber<void> | null = null;
  let probing: Fiber.Fiber<void> | null = null;

  function stop(): void {
    for (const fiber of [pings, probing]) {
      if (fiber !== null) run(Fiber.interrupt(fiber));
    }
    pings = null;
    probing = null;
  }

  const declareDead = Effect.sync(() => {
    stop();
    deps.onDead();
  });

  // A ping the wire refused is left to the close that follows.
  const sendPing = Effect.try(() => deps.sendPing()).pipe(
    Effect.andThen(Clock.currentTimeMillis),
    Effect.map((now) => {
      if (pingSentAt === null) pingSentAt = now;
    }),
    Effect.ignore,
  );

  // One beat: a ping when none is outstanding, else the verdict on the
  // oldest one. Answers whether the socket is still alive.
  const beat = Effect.gen(function* () {
    if (pingSentAt === null) {
      yield* sendPing;
      return true;
    }
    return (yield* Clock.currentTimeMillis) - pingSentAt < timeoutMs;
  });

  return {
    start() {
      if (pings !== null) return;
      pings = run(
        Effect.sleep(intervalMs).pipe(
          Effect.andThen(
            beat.pipe(
              Effect.repeat({
                schedule: Schedule.spaced(intervalMs),
                while: (alive) => alive,
              }),
            ),
          ),
          Effect.andThen(declareDead),
        ),
      );
    },
    stop,
    noteInbound() {
      pingSentAt = null;
    },
    probe() {
      if (pings === null || probing !== null) return;
      probing = run(
        Effect.gen(function* () {
          yield* sendPing;
          const sentAt = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(probeTimeoutMs);
          probing = null;
          // Any frame since the probe went out is the answer.
          if (pingSentAt !== null && pingSentAt <= sentAt) yield* declareDead;
        }),
      );
    },
  };
}
