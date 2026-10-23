// Which builds run as a profile (shared/packaging/appName.mts): a dev
// run and a test flavor do, so the lab's walks can run one packaged
// build as two devices, and a release build never does, whatever its
// environment says.
//
// Run: pnpm test build-profiles.
import assert from "node:assert/strict";
import { it } from "vitest";
import { DEV_PROFILE_ENV, profileFromEnv } from "@shared/packaging/appName.mts";
import { derive, FLAVORS } from "@shigomori/engine/flavor";

const env = { [DEV_PROFILE_ENV]: "walk-a" };

it("a release build ignores a profile in its environment", () => {
  assert.equal(
    profileFromEnv(
      { packaged: true, debuggable: FLAVORS.prod.debuggable },
      env,
    ),
    null,
  );
});

it("a dev run and a packaged test flavor run as the profile named", () => {
  assert.equal(
    profileFromEnv(
      { packaged: false, debuggable: FLAVORS.dev.debuggable },
      env,
    ),
    "walk-a",
  );
  assert.equal(
    profileFromEnv(
      { packaged: true, debuggable: derive("lab").debuggable },
      env,
    ),
    "walk-a",
  );
  assert.throws(() =>
    profileFromEnv(
      { packaged: true, debuggable: true },
      { [DEV_PROFILE_ENV]: "../x" },
    ),
  );
});
