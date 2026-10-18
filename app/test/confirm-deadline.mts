// Proof for the two-step confirm's deadline
// (renderer/hooks/ui/useConfirmTwice.ts, confirmInTime): the second
// click confirms only while both clocks say it is in time, so neither a
// sleep (the monotonic clock stands still while the wall one runs on)
// nor a clock step (the wall one jumps, the monotonic one doesn't)
// stretches an arm a timer could not clear.
//
// Run: pnpm test confirm-deadline.
import assert from "node:assert/strict";
import { it } from "vitest";
import { confirmInTime } from "../renderer/hooks/ui/useConfirmTwice";

const TIMEOUT = 5_000;
const arm = { monotonic: 1_000, wall: 1_000_000 };

it("a second click within the timeout confirms", () => {
  assert.equal(
    confirmInTime(arm, TIMEOUT, { monotonic: 3_000, wall: 1_002_000 }),
    true,
  );
});

it("a click past the timeout re-arms, whatever the timer did", () => {
  assert.equal(
    confirmInTime(arm, TIMEOUT, { monotonic: 7_000, wall: 1_006_000 }),
    false,
  );
});

it("a sleep past the timeout re-arms", () => {
  // The monotonic clock stood still through an hour's sleep.
  assert.equal(
    confirmInTime(arm, TIMEOUT, { monotonic: 1_500, wall: 4_600_000 }),
    false,
  );
});

it("a clock stepped back re-arms", () => {
  assert.equal(
    confirmInTime(arm, TIMEOUT, { monotonic: 2_000, wall: 1_000 }),
    false,
  );
});
