// Drives the pure liveness rate limiters (main/core/liveness/rateLimit.ts)
// under plain Node. The Electron wiring around them (setLoginItemSettings,
// render-process-gone, app.relaunch) cannot run headlessly and is a
// human-verify item for the PR, but the sliding-window math that decides
// recreate-vs-give-up and relaunch-vs-stand is pure, so it is asserted
// here. Node 22.18+ strips the .ts types on import, so no bundler or
// alias loader is needed: the module imports nothing.
import assert from "node:assert/strict";
import {
  CRASH_LOOP,
  FATAL_RELAUNCH,
  relaunchAllowed,
  decide,
  GONE_TOGETHER_MS,
  rendererGone,
} from "../main/core/liveness/rateLimit.ts";
import { it } from "vitest";
import { lastOf } from "./lib/checkKit.mts";

// When one fails: the renderer crash-loop and fatal-relaunch rate
// limiters in main/core/liveness/rateLimit.ts changed shape. Re-derive
// the expected recreate/relaunch decisions or restore the
// sliding-window semantics.

// Renderer crash-loop guard: a burst up to the ceiling recreates, the
// one past it gives up, and the persisted list only ever holds the
// in-window timestamps.
it("crash loop allows a burst up to the ceiling", () => {
  let recent: number[] = [];
  let now = 1_000;
  for (let i = 0; i < CRASH_LOOP.max; i++) {
    const decision = decide(recent, now, CRASH_LOOP);
    assert.equal(decision.allow, true, `recreation ${i + 1} should proceed`);
    recent = decision.recent;
    now += 1_000;
  }
  assert.equal(recent.length, CRASH_LOOP.max);
});

it("crash loop gives up past the ceiling", () => {
  // CRASH_LOOP.max recreations already recorded inside the window.
  const recent = Array.from({ length: CRASH_LOOP.max }, (_, i) => 1_000 + i);
  const decision = decide(recent, 2_000, CRASH_LOOP);
  assert.equal(decision.allow, false, "the extra crash must give up");
  // Giving up records nothing new: the list is only pruned, not grown.
  assert.equal(decision.recent.length, CRASH_LOOP.max);
});

it("crash loop resets once the window elapses", () => {
  const recent = Array.from({ length: CRASH_LOOP.max }, (_, i) => 1_000 + i);
  // A crash well past the window (measured from the LAST timestamp) sees
  // an empty in-window set and proceeds.
  const now = lastOf(recent) + CRASH_LOOP.windowMs + 1;
  const decision = decide(recent, now, CRASH_LOOP);
  assert.equal(decision.allow, true, "a crash after the window recovers");
  assert.deepEqual(decision.recent, [now], "stale timestamps are pruned");
});

// Fatal-relaunch guard: a count since the last stable run, no clock.
it("fatal relaunch allows up to the cap, then lets the crash stand", () => {
  for (let relaunches = 0; relaunches < FATAL_RELAUNCH.max; relaunches++) {
    assert.equal(relaunchAllowed(relaunches), true);
  }
  assert.equal(relaunchAllowed(FATAL_RELAUNCH.max), false);
});

// A renderer gone outside the app's own teardown comes back, whatever
// killed it: a SIGTERM from another tool reads "killed" like our own
// quit does, and a window left on it stays blank.
it("a renderer gone recreates its window unless the app is tearing it down", () => {
  assert.equal(
    rendererGone({ ownTeardown: false, recent: [], now: 1_000 }).verdict,
    "recreate",
  );
  const torn = rendererGone({ ownTeardown: true, recent: [500], now: 1_000 });
  assert.equal(torn.verdict, "ignore");
  assert.deepEqual(torn.recent, [500], "a teardown spends none of the budget");
});

it("a renderer gone again and again gives up past the crash-loop budget", () => {
  let recent: number[] = [];
  const verdicts: string[] = [];
  for (let i = 0; i <= CRASH_LOOP.max; i++) {
    const next = rendererGone({
      ownTeardown: false,
      recent,
      now: 1_000 + i * GONE_TOGETHER_MS,
    });
    verdicts.push(next.verdict);
    recent = next.recent;
  }
  assert.deepEqual(verdicts, [
    ...Array.from({ length: CRASH_LOOP.max }, () => "recreate"),
    "give-up",
  ]);
});

it("every window gone in one kill spends the budget once", () => {
  let recent: number[] = [];
  for (let window = 0; window < CRASH_LOOP.max + 3; window++) {
    const next = rendererGone({
      ownTeardown: false,
      recent,
      now: 1_000 + window * 10,
    });
    assert.equal(next.verdict, "recreate", `window ${window + 1} came back`);
    recent = next.recent;
  }
  assert.deepEqual(recent, [1_000]);
  const later = rendererGone({
    ownTeardown: false,
    recent,
    now: 1_000 + GONE_TOGETHER_MS,
  });
  assert.equal(later.verdict, "recreate");
  assert.equal(later.recent.length, 2, "a later one counts again");
});

it("a renderer dying again and again within a second gives up within a few seconds", () => {
  let recent: number[] = [];
  let now = 1_000;
  let verdict = "recreate";
  while (verdict === "recreate" && now < 60_000) {
    const next = rendererGone({ ownTeardown: false, recent, now });
    verdict = next.verdict;
    recent = next.recent;
    now += 100;
  }
  assert.equal(verdict, "give-up");
  assert.ok(now - 1_000 < (CRASH_LOOP.max + 1) * GONE_TOGETHER_MS);
});

it("every window gone in one kill past the budget gives up with one dialog", () => {
  const spent = [1_000, 2_000, 3_000];
  const verdicts = [5_000, 5_010, 5_020].map(
    (now, i) =>
      rendererGone({
        ownTeardown: false,
        recent: spent,
        now,
        lastGiveUp: i === 0 ? undefined : 5_000,
      }).verdict,
  );
  assert.deepEqual(verdicts, ["give-up", "give-up-quietly", "give-up-quietly"]);
});
