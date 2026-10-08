// A restart ladder (supervisor.ts) as a Schedule, for a supervised run
// that is repeated whenever it ends. Its input is how long the run
// lasted in milliseconds: one that stayed up for `stableMs` broke the
// failure streak, so the next restart starts the ladder from the
// bottom. Each restart climbs a rung, capped at the last.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { backoffDelayMs, STABLE_CONNECTION_MS } from "./supervisor";

export const restartSchedule = (
  ladder: readonly [number, ...number[]],
  stableMs: number = STABLE_CONNECTION_MS,
): Schedule.Schedule<number, number> =>
  Schedule.fromStep(
    Effect.sync(() => {
      let attempt = 0;
      return (_now: number, uptimeMs: number) => {
        if (uptimeMs >= stableMs) attempt = 0;
        const delay = Duration.millis(backoffDelayMs(ladder, attempt));
        attempt += 1;
        return Effect.succeed([attempt, delay] as [number, Duration.Duration]);
      };
    }),
  );
