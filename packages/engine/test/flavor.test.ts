import assert from "node:assert/strict";
import { it } from "vitest";
import {
  derive,
  FLAVORS,
  type FlavorNames,
  flavorNames,
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

it("derives a test flavor's names from its word", () => {
  assert.deepEqual(derive("lab"), {
    appName: "Shigoto no Mori (lab)",
    userDataDir: "Shigoto no Mori (lab)",
    bundleId: "com.sylophi.shigomori.lab",
    scheme: "shigomori-lab",
    dataDir: ".smlab",
    legacyDataDir: null,
    configDir: "shigomori-lab",
    pointer: "data-dir",
    legacyPointer: null,
    binaryName: "smlab",
    alias: "shigomori-lab",
    updates: false,
    debuggable: true,
  });
  assert.equal(flavorNames("lab").binaryName, "smlab");
  for (const flavor of ["prod", "dev"] as const) {
    assert.equal(flavorNames(flavor).debuggable, false, flavor);
  }
});

it("takes a word for a test flavor, not a build's or one whose names are a build's", () => {
  for (const word of ["lab", "exp", "a1", "smoke"]) {
    assert.ok(isTestFlavor(word) && isFlavor(word), word);
  }
  // `d` would be dev's own names, the rest no word.
  for (const word of [
    "prod",
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
it("leaves a test flavor sharing nothing with prod or dev", () => {
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
  const builds = new Set(["prod", "dev"].flatMap(everything));
  for (const word of ["lab", "exp", "smoke"]) {
    for (const value of everything(word)) {
      assert.ok(!builds.has(value), `${word}: ${value}`);
    }
  }
});
