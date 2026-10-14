import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compareVersions } from "../src/releaseVersions.ts";

describe("compareVersions", () => {
  it("orders the spec's example and the shapes this repo tags", () => {
    // Each strictly lower than the next.
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.7.1",
      "v1.10.0",
      "2.0.0-beta.1",
      "2.0.0-beta.2",
      "2.0.0-test.keychain-prompts.1",
      "2.0.0",
    ];
    ordered.forEach((a, i) => {
      ordered.forEach((b, j) => {
        assert.equal(compareVersions(a, b), Math.sign(i - j), `${a} vs ${b}`);
      });
    });
  });

  it("ranks what doesn't parse below everything", () => {
    assert.equal(compareVersions("dev", "0.0.1"), -1);
    assert.equal(compareVersions("1.02.0", "dev"), 0);
  });
});
