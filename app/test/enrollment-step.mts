// Proof for where a device's enrollment stands (useEnrollment's
// enrollmentStep), which the sign-in button and the migration screen
// read: the button in the account page's banners, shown while the
// device reads enrolled (its Clerk session lapsed, or the hub refused
// its credential), decides on the session alone, as v2's did: Sign in
// where it lapsed, Retry enrollment where it lives.
//
// Run: pnpm test enrollment-step.
import assert from "node:assert/strict";
import { it } from "vitest";
import { enrollmentStep } from "../renderer/hooks/account/useEnrollment";

const step = (facts: Partial<Parameters<typeof enrollmentStep>[0]>) =>
  enrollmentStep({
    enrolled: false,
    enrolling: false,
    sessionLives: false,
    again: false,
    ...facts,
  });

it("an enrolled device is done, unless asked again, which follows the session", () => {
  assert.equal(step({ enrolled: true, sessionLives: true }), "done");
  assert.equal(step({ enrolled: true, again: true }), "sign-in");
  assert.equal(
    step({ enrolled: true, again: true, sessionLives: true }),
    "enroll",
  );
});

it("a device not enrolled signs in, enrolls, or waits on the enrollment under way", () => {
  assert.equal(step({}), "sign-in");
  assert.equal(step({ sessionLives: true }), "enroll");
  assert.equal(step({ sessionLives: true, enrolling: true }), "enrolling");
});
