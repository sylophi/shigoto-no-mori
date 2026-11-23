// The restart ladder the app's retry loops share: the peer keeper, the
// mirror daemon, the renderer's terminal feed. Deterministic on
// purpose: fixed with no random jitter (the renderer runtime forbids
// Math.random anyway), on the Clock of the context it runs in.
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

// Backoff delays in milliseconds, capped at the last rung. Fixed and
// jitter-free.
export const BACKOFF_LADDER_MS: readonly [number, ...number[]] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];

// A connection open at least this long before it drops is treated as
// healthy, so its next reconnect starts the ladder from the bottom.
const STABLE_CONNECTION_MS = 30_000;

// A backoff wait that can be cut short, for a loop that should try
// again the moment the platform says the network is back. `now` ends
// the wait in progress, if any.
export type Wake = {
  readonly wait: (delay: Duration.Duration) => Effect.Effect<void>;
  readonly now: () => void;
};

export function makeWake(): Wake {
  let waiting: Deferred.Deferred<void> | null = null;
  return {
    wait: (delay) =>
      Effect.suspend(() => {
        const cut = Deferred.makeUnsafe<void>();
        waiting = cut;
        return Effect.raceFirst(Effect.sleep(delay), Deferred.await(cut)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (waiting === cut) waiting = null;
            }),
          ),
        );
      }),
    now: () => {
      if (waiting !== null) Deferred.doneUnsafe(waiting, Effect.void);
    },
  };
}

// A schedule whose waits are `wake` waits: the wait runs in the step,
// which answers no delay of its own. Last in a pipe, so what comes
// before it (a status tap, another ladder) sees the delay it waits.
export const wakeable =
  (wake: Wake) =>
  <Out, In, E, R>(
    schedule: Schedule.Schedule<Out, In, E, R>,
  ): Schedule.Schedule<Out, In, E, R> =>
    schedule.pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.as(wake.wait(duration), Duration.zero),
      ),
    );

// A restart ladder as a Schedule, for a run that is repeated whenever
// it ends. Its input is how long the run
// lasted in milliseconds: one that stayed up for STABLE_CONNECTION_MS broke the
// failure streak, so the next restart starts the ladder from the
// bottom. Each restart climbs a rung, capped at the last.
export const restartSchedule = (
  ladder: readonly [number, ...number[]],
): Schedule.Schedule<number, number> =>
  Schedule.fromStep(
    Effect.sync(() => {
      let attempt = 0;
      return (_now: number, uptimeMs: number) => {
        if (uptimeMs >= STABLE_CONNECTION_MS) attempt = 0;
        const delay = Duration.millis(backoffDelayMs(ladder, attempt));
        attempt += 1;
        return Effect.succeed([attempt, delay] as [number, Duration.Duration]);
      };
    }),
  );

// The ladder lookup, clamped at both ends.
export function backoffDelayMs(
  ladder: readonly [number, ...number[]],
  attempt: number,
): number {
  const index = Math.min(Math.max(attempt, 0), ladder.length - 1);
  return ladder[index] ?? ladder[0];
}
