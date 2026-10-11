// Durable proof for the mirror's one-line status (describeMirror in
// ui's views/worktreeDetail/mirror/mirrorStatus.ts). The
// engine runs a cycle on every filesystem event, ignored paths
// included, so a live mirror passes through its scanning states all
// the time without a file moving.
//
// Asserts: after the first pass, the checking states read as Live
// with the watching detail, the states that move files read as
// Syncing, and the first pass reads as Syncing throughout.
//
// Run: pnpm test mirror-status.
import assert from "node:assert/strict";
import type { MirrorStatus } from "@shigomori/contracts/modules/mirror";
import { describeMirror } from "@shigomori/ui/views/worktreeDetail/mirror/mirrorStatus.ts";
import { it } from "vitest";
import { mirrorEndpoint, rawMirrorSession } from "./lib/mirrorFakes.mts";

// One file at each end, as a session that has made its first pass.
const endpoint = mirrorEndpoint({ directories: 1, files: 1, totalFileSize: 1 });

const view = (status: MirrorStatus, successfulCycles: number) =>
  describeMirror({
    ...rawMirrorSession({
      session: "s",
      localRoot: "/a",
      deviceId: "B",
      projectId: "p",
      worktreeId: "w",
      remoteRoot: "/b",
      local: endpoint,
      remote: endpoint,
      status,
      successfulCycles,
    }),
    localProjectId: "p",
    localWorktreeId: "w",
    ignoreMode: "everything",
    lastError: "",
    git: { status: "synced", detail: "" },
  });

const CHECKING: MirrorStatus[] = [
  "scanning",
  "waiting-for-rescan",
  "reconciling",
  "saving",
];
const MOVING: MirrorStatus[] = [
  "staging-local",
  "staging-remote",
  "transitioning",
];

it("a check after the first pass reads as Live", () => {
  for (const status of CHECKING) {
    const { label, detail, spinning } = view(status, 3);
    assert.deepEqual(
      { label, detail, spinning },
      { label: "Live", detail: "watching for changes", spinning: false },
      status,
    );
  }
});

it("moving files reads as Syncing", () => {
  for (const status of MOVING) {
    assert.equal(view(status, 3).label, "Syncing", status);
  }
});

it("the first pass reads as Syncing", () => {
  for (const status of [...CHECKING, ...MOVING]) {
    assert.equal(view(status, 0).label, "Syncing", status);
  }
  assert.equal(view("scanning", 0).detail, "looking for changes");
});
