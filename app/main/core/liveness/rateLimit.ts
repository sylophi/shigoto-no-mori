// The rate limits of the two liveness recovery paths (electron/liveness.ts):
// the renderer's sliding window over recent recreations, and the fatal
// relaunches' count.

// A renderer that dies and gets recreated only to die again is a loop:
// a fourth crash within the window gives up.
const CRASH_LOOP = { windowMs: 30_000, max: 3 };

// Main-process fatal-relaunch guard. A deterministic startup crash would
// otherwise relaunch forever, so two relaunches with no stable run of a
// few minutes between them, then the crash stands. Counted, not timed:
// the count outlives the process, and no clock does that a step can't
// move.
export const FATAL_RELAUNCH = { max: 2, stableMs: 3 * 60_000 };

export const relaunchAllowed = (relaunches: number): boolean =>
  relaunches < FATAL_RELAUNCH.max;

// `recent` holds when the actions before this one were taken, and comes
// back pruned to the window, with `now` when this one is allowed.
function decide(
  recent: readonly number[],
  now: number,
  policy: { windowMs: number; max: number },
): { allow: boolean; recent: number[] } {
  const within = recent.filter((t) => now - t < policy.windowMs);
  if (within.length >= policy.max) return { allow: false, recent: within };
  return { allow: true, recent: [...within, now] };
}

// What a window does when its renderer is gone. Only the app's own
// teardown (a quit, or the window closing) explains it: an exit's
// reason doesn't, since "killed" and "clean-exit" are also what a
// signal from outside the app (another tool, macOS under memory
// pressure) reads as, and a window left on a dead renderer is blank for
// good. Anything else recreates the window, within the crash-loop
// budget, where every window gone within a second of the last counted
// one is that one kill, so a signal that takes every window spends it
// once.
const GONE_TOGETHER_MS = 1_000;

export function rendererGone(input: {
  readonly ownTeardown: boolean;
  readonly recent: readonly number[];
  readonly now: number;
  // When a window last gave up: one kill past the budget says so once.
  readonly lastGiveUp?: number | undefined;
}): {
  verdict: "ignore" | "recreate" | "give-up" | "give-up-quietly";
  recent: number[];
} {
  const recent = [...input.recent];
  if (input.ownTeardown) return { verdict: "ignore", recent };
  const last = recent.at(-1);
  if (last !== undefined && input.now - last < GONE_TOGETHER_MS) {
    return { verdict: "recreate", recent };
  }
  const decided = decide(recent, input.now, CRASH_LOOP);
  if (decided.allow) return { verdict: "recreate", recent: decided.recent };
  const quietly =
    input.lastGiveUp !== undefined &&
    input.now - input.lastGiveUp < GONE_TOGETHER_MS;
  return {
    verdict: quietly ? "give-up-quietly" : "give-up",
    recent: decided.recent,
  };
}
