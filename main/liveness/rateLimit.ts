// Pure, Electron-free rate limiters for the two liveness recovery paths.
// Both are sliding-window counters: given the timestamps of recent
// recoveries and the current time, decide whether one more is allowed
// and return the pruned-and-appended list to persist for next time.
// Keeping this logic here (importing nothing) is what lets
// scripts/check-liveness.mjs drive it under plain Node, since the
// Electron wiring around it can only be exercised in a real app.

// Renderer crash-loop guard. A renderer that dies and gets recreated
// only to die again is a loop, so allow a small burst of recreations
// inside a short window and then stop thrashing and surface an error
// instead. Three recreations inside thirty seconds is the ceiling: a
// fourth crash in that window gives up.
export const CRASH_LOOP_WINDOW_MS = 30_000;
export const CRASH_LOOP_MAX = 3;

// Main-process fatal-relaunch guard. A deterministic startup crash would
// otherwise relaunch forever, so cap relaunches to a couple inside a few
// minutes. The window is deliberately long and the count deliberately
// low: two relaunches inside three minutes, then stop and let the crash
// stand rather than spin.
export const FATAL_RELAUNCH_WINDOW_MS = 3 * 60_000;
export const FATAL_RELAUNCH_MAX = 2;

// The shared sliding-window decision. `recent` is the timestamps of
// prior actions we took, `now` is the current time. Prune anything
// older than the window, and if the surviving count has already reached
// `max`, refuse (returning the pruned list unchanged). Otherwise allow
// and return the pruned list with `now` appended, which is what the
// caller persists so the next call sees this action.
function decide(
  recent: readonly number[],
  now: number,
  windowMs: number,
  max: number,
): { allow: boolean; recent: number[] } {
  const within = recent.filter((t) => now - t < windowMs);
  if (within.length >= max) return { allow: false, recent: within };
  return { allow: true, recent: [...within, now] };
}

// Decide whether to recreate the window after a renderer crash. `recreate`
// false means the loop guard tripped and the caller should give up and
// show an error rather than spawn another doomed renderer.
export function shouldRecreateWindow(
  recent: readonly number[],
  now: number,
): { recreate: boolean; recent: number[] } {
  const { allow, recent: next } = decide(
    recent,
    now,
    CRASH_LOOP_WINDOW_MS,
    CRASH_LOOP_MAX,
  );
  return { recreate: allow, recent: next };
}

// Decide whether to relaunch the app after a fatal main-process error.
// `relaunch` false means the rate limit tripped and the caller should
// let the crash stand rather than respawn into the same failure.
export function shouldRelaunchAfterFatal(
  recent: readonly number[],
  now: number,
): { relaunch: boolean; recent: number[] } {
  const { allow, recent: next } = decide(
    recent,
    now,
    FATAL_RELAUNCH_WINDOW_MS,
    FATAL_RELAUNCH_MAX,
  );
  return { relaunch: allow, recent: next };
}
