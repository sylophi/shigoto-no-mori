// Whether a link to another machine still answers, judged only from a
// probe the far end had the whole timeout to answer while this end ran
// (V3.md, "Time"). Effect's pinger judged the age of the last frame
// before it sent a ping, on the wall clock: a hidden page whose timers
// run once a minute cut a quiet, healthy peer on its next turn, and a
// wake cut whatever was asked before the sleep.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

// How late a turn may come before it means this end was not running
// (a hidden page's throttled timers, a sleep, a stopped process).
const LATE_MS = 5_000;

const nanosToMs = (nanos: bigint) => Number(nanos / 1_000_000n);

// Every `intervalMs`, a probe (`ping`, a round trip) unless one is out.
// Its answer, or any frame heard after it went (`heard` counts them: a
// link busy carrying a transfer may queue the answer behind it), ends
// it. One out past `timeoutMs` of turns that came on time is the far
// end's silence, and `dead` runs. A late turn starts the observation
// again: the probe out is set aside, and a new one asks.
export const watchLiveness = (options: {
  readonly ping: Effect.Effect<unknown, unknown>;
  readonly heard: () => number;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly dead: Effect.Effect<void>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const read = Effect.all({
      wall: Clock.currentTimeMillis,
      mono: Effect.map(Clock.monotonicTimeNanos, nanosToMs),
    });
    let last = yield* read;
    let probe: {
      readonly sentAt: number;
      readonly heardAt: number;
      answered: boolean;
    } | null = null;
    while (true) {
      yield* Effect.sleep(options.intervalMs);
      const now = yield* read;
      const late =
        Math.max(now.wall - last.wall, now.mono - last.mono) >
        options.intervalMs + LATE_MS;
      last = now;
      if (
        probe !== null &&
        (probe.answered || late || options.heard() > probe.heardAt)
      ) {
        probe = null;
      }
      if (probe !== null) {
        if (now.mono - probe.sentAt >= options.timeoutMs) {
          return yield* options.dead;
        }
        continue;
      }
      const asked = {
        sentAt: now.mono,
        heardAt: options.heard(),
        answered: false,
      };
      probe = asked;
      yield* options.ping.pipe(
        Effect.andThen(
          Effect.sync(() => {
            asked.answered = true;
          }),
        ),
        Effect.ignore,
        Effect.forkChild,
      );
    }
  });
