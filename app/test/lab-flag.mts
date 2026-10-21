// Which builds take the lab's flag (main/argFlags.ts startedForLab): a
// dev run and a test flavor do, so the lab's tools reach their page api
// and relaunch them, and a shipped build ignores it.
//
// Run: pnpm test lab-flag.
import assert from "node:assert/strict";
import { it } from "vitest";
import { LAB_FLAG, startedForLab } from "../main/argFlags";
import { derive, FLAVORS } from "@shigomori/engine/flavor";

const argv = ["/Applications/App.app/Contents/MacOS/App", LAB_FLAG];

it("a shipped build ignores the lab's flag", () => {
  for (const flavor of ["prod", "v3"] as const) {
    assert.equal(
      startedForLab(argv, {
        packaged: true,
        debuggable: FLAVORS[flavor].debuggable,
      }),
      false,
      flavor,
    );
  }
});

it("a dev run and a packaged test flavor take it, when given", () => {
  assert.equal(
    startedForLab(argv, {
      packaged: false,
      debuggable: FLAVORS.dev.debuggable,
    }),
    true,
  );
  const lab = { packaged: true, debuggable: derive("lab").debuggable };
  assert.equal(startedForLab(argv, lab), true);
  assert.equal(startedForLab(argv.slice(0, 1), lab), false);
});
