// Whether a link to another machine still answers, judged only from a
// probe the far end had its whole window to answer while this end ran
// (V3.md, "Time"). One observation for the device links and the hub
// socket. Effect's pinger judged the age of the last frame before it
// sent a ping, on the wall clock: a hidden page whose timers run once a
// minute cut a quiet, healthy peer on its next turn, and a wake cut
// whatever was asked before the sleep.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

// How late a turn may come before it means this end was not running
// (a hidden page's throttled timers, a sleep, a stopped process).
const LATE_MS = 5_000;

const nanosToMs = (nanos: bigint) => Number(nanos / 1_000_000n);

const readClocks = Effect.all({
  wall: Clock.currentTimeMillis,
  mono: Effect.map(Clock.monotonicTimeNanos, nanosToMs),
});

// The same rule for one question asked at a moment that matters (a
// helper process after a wait, a host at a quit): what `ask` came back
// with, a failure or a defect included, or none once it stayed silent
// for `timeoutMs` that this end ran through. A wait whose limit came
// late by either clock asks again rather than say none.
export const answerWithin = Effect.fnUntraced(function* <A, E>(
  ask: Effect.Effect<A, E>,
  timeoutMs: number,
) {
  while (true) {
    const before = yield* readClocks;
    const answer = yield* ask.pipe(
      Effect.exit,
      Effect.timeoutOption(timeoutMs),
    );
    if (Option.isSome(answer)) return answer;
    const after = yield* readClocks;
    const late =
      Math.max(after.wall - before.wall, after.mono - before.mono) >
      timeoutMs + LATE_MS;
    if (!late) return answer;
  }
});

// Every `intervalMs`, a probe unless one is out: `ping`, whose success
// answers it, or any frame heard after it went (`heard` counts them: a
// link busy carrying a transfer may queue the answer behind it, and the
// hub's answer is any frame). One out past `timeoutMs` is only the cue
// for a fresh probe, as is a `probe()` at a wake or a tab coming back;
// a fresh probe unanswered for `probeTimeoutMs` of turns that came on
// time is the far end's silence, and `dead` runs. A late turn (this end
// stopped, asleep, or a hidden page's throttled timers) interrupts the
// probe out and asks a fresh one, so the far end is judged on a window
// it had while this end ran. A stop shorter than LATE_MS that ends
// right at a verdict can still read it before the answer.
export const watchLiveness = Effect.fnUntraced(function* (options: {
  readonly ping: Effect.Effect<unknown, unknown>;
  readonly heard: () => number;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly dead: Effect.Effect<void>;
}) {
  const wanted = yield* Queue.sliding<void>(1);

  const observe = Effect.gen(function* () {
    let last = yield* readClocks;
    // The probe out, with its ping's fiber, interrupted when it is set
    // aside.
    let probe: {
      readonly sentAt: number;
      readonly heardAt: number;
      readonly fresh: boolean;
      readonly answered: () => boolean;
      readonly pinging: Fiber.Fiber<void>;
    } | null = null;
    const ask = Effect.fnUntraced(function* (fresh: boolean) {
      if (probe !== null) yield* Fiber.interrupt(probe.pinging);
      let answered = false;
      // Read after the interrupt, which can wait on the wire.
      const at = yield* readClocks;
      const pinging = yield* options.ping.pipe(
        Effect.andThen(
          Effect.sync(() => {
            answered = true;
          }),
        ),
        Effect.ignore,
        Effect.forkChild,
      );
      return {
        sentAt: at.mono,
        heardAt: options.heard(),
        fresh,
        answered: () => answered,
        pinging,
      };
    });
    const windowOf = (out: { readonly fresh: boolean }) =>
      out.fresh ? options.probeTimeoutMs : options.timeoutMs;
    while (true) {
      const stepMs =
        probe === null
          ? options.intervalMs
          : Math.max(
              0,
              Math.min(
                options.intervalMs,
                probe.sentAt + windowOf(probe) - last.mono,
              ),
            );
      const asked = yield* Effect.race(
        Effect.as(Effect.sleep(stepMs), false),
        Effect.as(Queue.take(wanted), true),
      );
      const now = yield* readClocks;
      const late =
        Math.max(now.wall - last.wall, now.mono - last.mono) > stepMs + LATE_MS;
      last = now;
      if (asked || late) {
        // A fresh probe already out answers an ask on time.
        if (late || probe?.fresh !== true) probe = yield* ask(true);
      } else if (
        probe === null ||
        probe.answered() ||
        options.heard() > probe.heardAt
      ) {
        probe = yield* ask(false);
      } else if (now.mono - probe.sentAt >= windowOf(probe)) {
        if (probe.fresh) return yield* options.dead;
        probe = yield* ask(true);
      }
    }
  });
  yield* Effect.forkScoped(observe);
  return {
    probe: () => {
      Queue.offerUnsafe(wanted, undefined);
    },
  };
});
