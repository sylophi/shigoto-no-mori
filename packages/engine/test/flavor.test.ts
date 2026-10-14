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

it("builds an alpha or beta of 3.0.0 as v3 and anything else as prod", () => {
  assert.equal(flavorOfVersion("v3.0.0-alpha.1"), "v3");
  assert.equal(flavorOfVersion("3.0.0-beta.2"), "v3");
  assert.equal(flavorOfVersion("v3.0.0-beta"), "v3");
  assert.equal(flavorOfVersion("v3.0.0-rc.1"), "prod");
  assert.equal(flavorOfVersion("v3.0.0"), "prod");
  assert.equal(flavorOfVersion("v3.1.0-beta.1"), "prod");
  assert.equal(flavorOfVersion("v2.40.0-beta.1"), "prod");
  assert.equal(flavorOfVersion("v3.0.0-alphax.1"), "prod");
});
