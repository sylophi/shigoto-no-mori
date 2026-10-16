import assert from "node:assert/strict";
import { it } from "vitest";
import {
  derive,
  FLAVORS,
  type FlavorNames,
  flavorNames,
  flavorOfVersion,
  isFlavor,
  isTestFlavor,
} from "../src/flavor.ts";
import { footprint } from "../src/footprint.ts";

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

it("derives a test flavor's names by the rule v3 already fits", () => {
  const { updates: _updates, debuggable: _debuggable, ...v3 } = FLAVORS.v3;
  const { updates, debuggable, ...derived } = derive("v3");
  assert.deepEqual(derived, v3);
  assert.equal(updates, null);
  assert.equal(debuggable, true);
  assert.equal(flavorNames("lab").binaryName, "smlab");
  assert.equal(flavorNames("lab").appName, "Shigoto no Mori (lab)");
  for (const flavor of ["prod", "v3", "dev"] as const) {
    assert.equal(flavorNames(flavor).debuggable, false, flavor);
  }
});

it("takes a word for a test flavor, not a build's or one whose names are a build's", () => {
  for (const word of ["lab", "exp", "a1", "smoke"]) {
    assert.ok(isTestFlavor(word) && isFlavor(word), word);
  }
  // `d` and `v3` would be dev's and v3's own names, the rest no word.
  for (const word of [
    "prod",
    "v3",
    "dev",
    "d",
    "",
    "Lab",
    "1a",
    "a-b",
    "constructor",
  ]) {
    assert.ok(!isTestFlavor(word), word);
  }
});

// Nothing a test flavor puts on the machine is another build's: every
// file and folder, the keychain item, the shell hook's block, the agent
// hooks' command, the bundle id and the scheme.
it("leaves a test flavor sharing nothing with prod, v3 or dev", () => {
  const place = {
    home: "/Users/someone",
    configHome: "/Users/someone/.config",
    binHome: "/Users/someone/.local/bin",
  };
  const everything = (flavor: string) => {
    const { paths, ...shared } = footprint(flavor, place);
    return [...paths.map(({ path }) => path), ...Object.values(shared)].map(
      (value) => value.toLowerCase(),
    );
  };
  const builds = new Set(["prod", "v3", "dev"].flatMap(everything));
  for (const word of ["lab", "exp", "smoke"]) {
    for (const value of everything(word)) {
      assert.ok(!builds.has(value), `${word}: ${value}`);
    }
  }
});

it("builds an alpha, beta or rc of 3.0.0 as v3 and anything else as prod", () => {
  assert.equal(flavorOfVersion("v3.0.0-alpha.1"), "v3");
  assert.equal(flavorOfVersion("3.0.0-beta.2"), "v3");
  assert.equal(flavorOfVersion("v3.0.0-beta"), "v3");
  assert.equal(flavorOfVersion("v3.0.0-rc.1"), "v3");
  assert.equal(flavorOfVersion("v3.0.0"), "prod");
  assert.equal(flavorOfVersion("v3.1.0-beta.1"), "prod");
  assert.equal(flavorOfVersion("v2.40.0-beta.1"), "prod");
  assert.equal(flavorOfVersion("v3.0.0-alphax.1"), "prod");
});
