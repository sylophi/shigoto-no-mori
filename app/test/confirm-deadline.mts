// Proof for the page's deadlines (renderer/lib/deadline.ts), which a
// two-step confirm's second click, the villagers' quiet after a flow's
// own news and the account list's wait out of a 429 read: one has
// passed once either clock says so, so neither a sleep (the monotonic
// clock stands still while the wall one runs on) nor a clock step (the
// wall one jumps, the monotonic one doesn't) stretches it past what a
// timer could not clear.
//
// Run: pnpm test confirm-deadline.
import assert from "node:assert/strict";
import { it } from "vitest";
import { deadlineIn, deadlinePassed } from "../renderer/lib/deadline";

const TIMEOUT = 5_000;
const arm = deadlineIn(TIMEOUT, { monotonic: 1_000, wall: 1_000_000 });

it("within the timeout it holds", () => {
  assert.equal(
    deadlinePassed(arm, { monotonic: 3_000, wall: 1_002_000 }),
    false,
  );
});

it("past the timeout it has passed, whatever the timer did", () => {
  assert.equal(
    deadlinePassed(arm, { monotonic: 7_000, wall: 1_006_000 }),
    true,
  );
});

it("a sleep past the timeout passes it", () => {
  // The monotonic clock stood still through an hour's sleep.
  assert.equal(
    deadlinePassed(arm, { monotonic: 1_500, wall: 4_600_000 }),
    true,
  );
});

it("a clock stepped back passes it", () => {
  assert.equal(deadlinePassed(arm, { monotonic: 2_000, wall: 1_000 }), true);
});
