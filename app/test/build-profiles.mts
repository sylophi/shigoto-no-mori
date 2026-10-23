// Which builds run as a profile (shared/packaging/appName.mts): a dev
// run does, and a packaged build never does, whatever its environment
// says.
//
// Run: pnpm test build-profiles.
import assert from "node:assert/strict";
import { it } from "vitest";
import { DEV_PROFILE_ENV, profileFromEnv } from "@shared/packaging/appName.mts";

const env = { [DEV_PROFILE_ENV]: "second" };

it("a packaged build ignores a profile in its environment", () => {
  assert.equal(profileFromEnv(true, env), null);
});

it("a dev run runs as the profile named", () => {
  assert.equal(profileFromEnv(false, env), "second");
  assert.throws(() => profileFromEnv(false, { [DEV_PROFILE_ENV]: "../x" }));
});
