// A stop removes the copy, so a file either side couldn't read or write
// holds it: it may exist only on the copy.
import assert from "node:assert/strict";
import { it } from "vitest";
import { mirrorStopBlocker } from "../src/modules/mirror.ts";

const side = (problems: number, excludedProblems = 0) => ({
  connected: true,
  scanned: true,
  files: 1,
  problems: Array.from({ length: problems }, (_, i) => ({
    path: `notes${i}?.md`,
    error: "unable to create file",
  })),
  excludedProblems,
});

const session = (local = side(0), remote = side(0)) => ({
  paused: false,
  status: "watching" as const,
  successfulCycles: 2,
  conflicts: [],
  excludedConflicts: 0,
  local,
  remote,
  git: { status: "synced" as const, detail: "" },
});

it("stops a mirror in step", () => {
  assert.equal(mirrorStopBlocker(session()), undefined);
});

it("refuses while the original has problems", () => {
  assert.equal(
    mirrorStopBlocker(session(side(1))),
    "a file couldn't be copied",
  );
  assert.equal(
    mirrorStopBlocker(session(side(2, 3))),
    "5 files couldn't be copied",
  );
});

it("refuses while the copy has problems", () => {
  assert.equal(
    mirrorStopBlocker(session(side(0), side(2, 1))),
    "3 files couldn't be copied",
  );
});
