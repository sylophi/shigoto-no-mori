import assert from "node:assert/strict";
import { it } from "vitest";
import { FLAVORS, type FlavorNames, flavorOfVersion } from "../src/flavor.ts";

// What two builds on one machine must never share: each of these names a
// file, a folder, an OS registration or a command.
const OWN: ReadonlyArray<keyof FlavorNames> = [
  "appName",
  "userDataDir",
  "bundleId",
  "scheme",
  "dataDir",
  "configDir",
  "binaryName",
  "alias",
];

it("gives every flavor its own names", () => {
  const rows = Object.values(FLAVORS);
  for (const key of OWN) {
    const values = rows.map((row) => String(row[key]).toLowerCase());
    assert.equal(new Set(values).size, rows.length, key);
  }
});

it("builds a test tag as test and anything else as prod", () => {
  assert.equal(flavorOfVersion("v3.0.0-test.1"), "test");
  assert.equal(flavorOfVersion("3.0.0-test"), "test");
  assert.equal(flavorOfVersion("v3.0.0-rc.1"), "prod");
  assert.equal(flavorOfVersion("v3.0.0"), "prod");
  assert.equal(flavorOfVersion("v3.0.0-testing.1"), "prod");
});
