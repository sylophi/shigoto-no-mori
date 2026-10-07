// Durable proof for what a worktree's remote-sync state offers
// (renderer/lib/syncState.ts), the view the sidebar badge, the sync
// pill, the palette's git verb and the changes page all read. A dirty
// tree's wait is what keeps the pill on its hint, never diverged's
// overwrites.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test sync-state.
import assert from "node:assert/strict";
import { worktreeSyncView } from "@/lib/syncState";
import type { RemoteSyncState, Worktree } from "@shared/schemas";
import { worktree as fakeWorktree } from "../lab/fake-host/fixtures.ts";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("sync-state proof");
console.log("sync-state proof\n");

// One posed worktree per state, and whether its move runs beside
// uncommitted changes.
const POSES: Array<{
  pose: string;
  kind: RemoteSyncState["kind"];
  fields: Partial<Worktree>;
  move: string | null;
  label?: string;
  waits: boolean;
}> = [
  { pose: "synced", kind: "synced", fields: {}, move: null, waits: false },
  {
    pose: "detached",
    kind: "detached",
    fields: { detached: true, branch: "HEAD" },
    move: null,
    waits: false,
  },
  {
    pose: "publish",
    kind: "publish",
    fields: { hasUpstream: false },
    move: "publish",
    label: "Publish branch",
    waits: false,
  },
  {
    pose: "publish with no remote",
    kind: "publish",
    fields: { hasUpstream: false, hasRemote: false },
    move: "publish",
    label: "Publish branch",
    waits: false,
  },
  {
    pose: "ahead",
    kind: "ahead",
    fields: { ahead: 2 },
    move: "push",
    label: "Push 2 commits",
    waits: false,
  },
  {
    pose: "behind",
    kind: "behind",
    fields: { behind: 3 },
    move: "pull",
    label: "Pull 3 commits",
    waits: true,
  },
  {
    pose: "pull and push",
    kind: "pullAndPush",
    fields: { ahead: 2, behind: 3, divergedClean: true },
    move: "pullAndPush",
    label: "Pull and push ↑2↓3",
    waits: true,
  },
  {
    pose: "diverged",
    kind: "diverged",
    fields: { ahead: 2, behind: 3 },
    move: null,
    waits: true,
  },
];

const posed = (fields: Partial<Worktree>, changedCount: number): Worktree =>
  fakeWorktree({
    id: "wt",
    projectId: "p",
    name: "wt",
    branch: "feat/wt",
    path: "/src/wt",
    changedCount,
    ...fields,
  });

try {
  await proof.check(
    "a clean tree offers push, pull, publish and pull-and-push, in their words, and diverged none",
    () => {
      for (const { pose, kind, fields, move, label } of POSES) {
        const view = worktreeSyncView(posed(fields, 0));
        assert.equal(view.state.kind, kind, pose);
        assert.equal(view.waiting, false, `${pose} waits on a clean tree`);
        assert.equal(view.move?.key ?? null, move, pose);
        assert.equal(view.move?.label, label, `${pose}'s label`);
      }
    },
  );

  await proof.check(
    "publish with no remote offers its move disabled, with the reason",
    () => {
      const view = worktreeSyncView(
        posed({ hasUpstream: false, hasRemote: false }, 0),
      );
      assert.ok(view.move?.disabledReason);
      assert.equal(
        worktreeSyncView(posed({ hasUpstream: false }, 0)).move?.disabledReason,
        undefined,
      );
    },
  );

  await proof.check(
    "uncommitted changes keep push and publish, and hold pull, pull-and-push and diverged back",
    () => {
      for (const { pose, fields, move, waits } of POSES) {
        const view = worktreeSyncView(posed(fields, 2));
        assert.equal(view.waiting, waits, pose);
        if (waits) {
          assert.equal(view.move, null, `${pose} still offers its move`);
          assert.ok(view.held, `${pose} waits with no words for it`);
        } else {
          assert.equal(view.move?.key ?? null, move, pose);
          assert.equal(view.held, null, `${pose} has words for a wait`);
        }
      }
    },
  );

  await proof.check("the sidebar badge ignores the tree's changes", () => {
    for (const { pose, fields } of POSES) {
      assert.deepEqual(
        worktreeSyncView(posed(fields, 2)).badge,
        worktreeSyncView(posed(fields, 0)).badge,
        pose,
      );
    }
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
