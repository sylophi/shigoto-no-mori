// Durable proof for the mirror's one-line status (describeMirror in
// renderer/components/worktreeDetail/mirror/mirrorStatus.ts). The
// engine runs a cycle on every filesystem event, ignored paths
// included, so a live mirror passes through its scanning states all
// the time without a file moving.
//
// Asserts: after the first pass, the checking states read as Live
// with the watching detail, the states that move files read as
// Syncing, and the first pass reads as Syncing throughout.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test mirror-status.
import assert from "node:assert/strict";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import { makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("mirror-status proof");
console.log("mirror-status proof\n");

const endpoint = {
  connected: true,
  scanned: true,
  directories: 1,
  files: 1,
  symbolicLinks: 0,
  totalFileSize: 1,
  problems: [],
  excludedProblems: 0,
};

const view = (status, successfulCycles) =>
  describeMirror({
    paused: false,
    statusText: "",
    lastError: "",
    conflicts: [],
    excludedConflicts: 0,
    local: endpoint,
    remote: endpoint,
    git: { status: "synced", detail: "" },
    status,
    successfulCycles,
  });

const CHECKING = ["scanning", "waiting-for-rescan", "reconciling", "saving"];
const MOVING = ["staging-local", "staging-remote", "transitioning"];

try {
  await proof.check("a check after the first pass reads as Live", () => {
    for (const status of CHECKING) {
      const { label, detail, spinning } = view(status, 3);
      assert.deepEqual(
        { label, detail, spinning },
        { label: "Live", detail: "watching for changes", spinning: false },
        status,
      );
    }
  });

  await proof.check("moving files reads as Syncing", () => {
    for (const status of MOVING) {
      assert.equal(view(status, 3).label, "Syncing", status);
    }
  });

  await proof.check("the first pass reads as Syncing", () => {
    for (const status of [...CHECKING, ...MOVING]) {
      assert.equal(view(status, 0).label, "Syncing", status);
    }
    assert.equal(view("scanning", 0).detail, "looking for changes");
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
