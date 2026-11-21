// Whether another machine or process answers a question asked once
// (the terminal's handshake with the app, the shell's watchdog, a host
// at a quit), judged only on a window the far end had while this end
// ran (EFFECT.md, section 8).
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { elapsedMillis } from "./elapsed.ts";

// How late a turn may come before it means this end was not running
// (a hidden page's throttled timers, a sleep, a stopped process).
const LATE_MS = 5_000;

const readClocks = Effect.all({
  wall: Clock.currentTimeMillis,
  mono: elapsedMillis,
});

// The same rule for one question asked at a moment that matters (the
// watchdog's round, a host at a quit): what `ask` came back
// with, a failure or a defect included, or none once it stayed silent
// for `timeoutMs` that this end ran through. A wait whose limit came
// late by either clock asks again rather than say none.
export const answerWithin = Effect.fnUntraced(function* <A, E, R>(
  ask: Effect.Effect<A, E, R>,
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
