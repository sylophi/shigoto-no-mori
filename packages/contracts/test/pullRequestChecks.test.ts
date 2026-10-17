// One reading of a check, for the pull request panel and the engine's
// wait for a merge alike.
import assert from "node:assert/strict";
import { it } from "vitest";
import { checkBucket } from "../src/pullRequestChecks.ts";

it("reads a StatusContext by its state and a CheckRun by its status, then its conclusion", () => {
  assert.equal(checkBucket({ state: "SUCCESS" }), "passed");
  assert.equal(checkBucket({ state: "ERROR" }), "failing");
  assert.equal(checkBucket({ state: "EXPECTED" }), "pending");
  assert.equal(
    checkBucket({ status: "IN_PROGRESS", conclusion: "SUCCESS" }),
    "pending",
  );
  assert.equal(
    checkBucket({ status: "COMPLETED", conclusion: "NEUTRAL" }),
    "neutral",
  );
  assert.equal(
    checkBucket({ status: "COMPLETED", conclusion: "SKIPPED" }),
    "skipped",
  );
  assert.equal(
    checkBucket({ status: "COMPLETED", conclusion: "CANCELLED" }),
    "failing",
  );
});

it("reads a stale check as failing, and a verdict it doesn't know as pending", () => {
  assert.equal(
    checkBucket({ status: "COMPLETED", conclusion: "STALE" }),
    "failing",
  );
  assert.equal(
    checkBucket({ status: "COMPLETED", conclusion: "SOMETHING_NEW" }),
    "pending",
  );
  assert.equal(
    checkBucket({ state: "", status: "", conclusion: "" }),
    "pending",
  );
});
