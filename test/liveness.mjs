// Drives the pure liveness rate limiters (main/liveness/rateLimit.ts)
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
  decide,
} from "../main/liveness/rateLimit.ts";
import { makeChecker, report } from "./lib/checkKit.mjs";

const { check, failures } = makeChecker();

// Renderer crash-loop guard: a burst up to the ceiling recreates, the
// one past it gives up, and the persisted list only ever holds the
// in-window timestamps.
check("crash loop allows a burst up to the ceiling", () => {
  let recent = [];
  let now = 1_000;
  for (let i = 0; i < CRASH_LOOP.max; i++) {
    const decision = decide(recent, now, CRASH_LOOP);
    assert.equal(decision.allow, true, `recreation ${i + 1} should proceed`);
    recent = decision.recent;
    now += 1_000;
  }
  assert.equal(recent.length, CRASH_LOOP.max);
});

check("crash loop gives up past the ceiling", () => {
  // CRASH_LOOP.max recreations already recorded inside the window.
  const recent = Array.from({ length: CRASH_LOOP.max }, (_, i) => 1_000 + i);
  const decision = decide(recent, 2_000, CRASH_LOOP);
  assert.equal(decision.allow, false, "the extra crash must give up");
  // Giving up records nothing new: the list is only pruned, not grown.
  assert.equal(decision.recent.length, CRASH_LOOP.max);
});

check("crash loop resets once the window elapses", () => {
  const recent = Array.from({ length: CRASH_LOOP.max }, (_, i) => 1_000 + i);
  // A crash well past the window (measured from the LAST timestamp) sees
  // an empty in-window set and proceeds.
  const now = recent[recent.length - 1] + CRASH_LOOP.windowMs + 1;
  const decision = decide(recent, now, CRASH_LOOP);
  assert.equal(decision.allow, true, "a crash after the window recovers");
  assert.deepEqual(decision.recent, [now], "stale timestamps are pruned");
});

// Fatal-relaunch guard: the same shape with the long window and low cap.
check("fatal relaunch allows up to the cap", () => {
  let recent = [];
  let now = 5_000;
  for (let i = 0; i < FATAL_RELAUNCH.max; i++) {
    const decision = decide(recent, now, FATAL_RELAUNCH);
    assert.equal(decision.allow, true, `relaunch ${i + 1} should proceed`);
    recent = decision.recent;
    now += 10_000;
  }
  assert.equal(recent.length, FATAL_RELAUNCH.max);
});

check("fatal relaunch stops past the cap", () => {
  const recent = Array.from(
    { length: FATAL_RELAUNCH.max },
    (_, i) => 5_000 + i,
  );
  const decision = decide(recent, 6_000, FATAL_RELAUNCH);
  assert.equal(decision.allow, false, "a deterministic crash must stop");
  assert.equal(decision.recent.length, FATAL_RELAUNCH.max);
});

check("fatal relaunch resets once the window elapses", () => {
  const recent = Array.from(
    { length: FATAL_RELAUNCH.max },
    (_, i) => 5_000 + i,
  );
  const now = recent[recent.length - 1] + FATAL_RELAUNCH.windowMs + 1;
  const decision = decide(recent, now, FATAL_RELAUNCH);
  assert.equal(decision.allow, true, "a relaunch after the window recovers");
  assert.deepEqual(decision.recent, [now], "stale timestamps are pruned");
});

// A floor so a rename or a botched import cannot leave the check
// asserting nothing while still printing OK.
check("the limiter constants are sane", () => {
  assert.ok(CRASH_LOOP.max > 0 && CRASH_LOOP.windowMs > 0);
  assert.ok(FATAL_RELAUNCH.max > 0 && FATAL_RELAUNCH.windowMs > 0);
});

report({
  name: "liveness",
  failures,
  hint: "The renderer crash-loop and fatal-relaunch rate limiters in main/liveness/rateLimit.ts changed shape. Re-derive the expected recreate/relaunch decisions or restore the sliding-window semantics.",
});
