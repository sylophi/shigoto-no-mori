// Durable proof for the shelf's auto-unshelve (the engine's, run by a
// full worktree listing) against a REAL git repository, read the way the
// app reads it: the host's listWorktrees over the engine. The first
// listing of a shelved worktree records a snapshot in the store, a
// later listing leaves it shelved while nothing moved (the changes it
// was shelved with included), and unshelves it once it is worked in: an
// edit, a new file, a deleted file, a commit, a new edit to an already
// changed file. The cheap identities form settles nothing. An auto-pull
// worktree that only fast-forwards stays shelved, and a commit made in
// one still unshelves it. A listing that read a snapshot before a
// reshelve doesn't undo the reshelve. With autoShelveDays set, a
// worktree untouched for longer goes on the shelf by itself, and one
// unshelved by hand stays off it.
//
// Run: pnpm test shelf.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { delay, type Track, waitFor } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Scrubs this process's GIT_* (the pull below runs the app's git in
// it) and pins the fixture identity.
const fixture = cliSandbox("sm-shelf-");
beforeAll(async () => {
  await fixture.buildSm();
  await fixture.useCli();
});
afterAll(() => fixture.remove());
const { dataDir, git, gitOut, commitFile, sandbox, sm } = fixture;

const { listWorktreeIdentities, listWorktrees, setAutoPull, setShelved } =
  await import("../host/lib/engineCalls.ts");
const Engine = await import("../host/lib/engine.ts");
const { autoPullWorktree } =
  await import("../host/lib/worktrees/autoPullSweep.ts");

// What the store holds for the shelf, read on the engine's own
// connection.
type Snapshot = { at: number; head: string | null; changed: number };
const snapshotOf = (id: string): Promise<Snapshot | undefined> =>
  Engine.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<Snapshot>`SELECT at, head, changed
        FROM shelf_snapshots WHERE worktree_id = ${id}`;
      return row === undefined ? undefined : { ...row };
    }),
  );
const markedShelved = (id: string): Promise<boolean> =>
  Engine.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT 1 FROM worktree_marks
        WHERE worktree_id = ${id} AND mark = 'shelved'`;
      return rows.length > 0;
    }),
  );

// A bare origin, a project cloned from it and registered through the
// CLI, and a linked worktree of it under the managed root (an external
// worktree can't be shelved) on its own pushed branch. The seed clone
// plays the colleague.
let sandboxes = 0;
async function makeSandbox(track: Track) {
  sandboxes += 1;
  const root = join(sandbox, `box${sandboxes}`);
  mkdirSync(root);
  track(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  await git(root, ["init", "--bare", "-q", "-b", "main", origin]);
  const seed = join(root, "seed");
  await git(root, ["init", "-q", "-b", "main", seed]);
  await git(seed, ["remote", "add", "origin", origin]);
  writeFileSync(join(seed, "a.txt"), "a\n");
  await commitFile(seed, "b.txt", "b\n", "seed");
  await git(seed, ["push", "-q", "-u", "origin", "main"]);
  // A basename of its own, so each sandbox gets its own managed base.
  const project = join(root, `project${sandboxes}`);
  await git(root, ["clone", "-q", origin, project]);
  const worktree = join(dataDir, "wt", basename(project), "linked");
  track(() => rmSync(worktree, { recursive: true, force: true }));
  await git(project, ["worktree", "add", "-q", "-b", "feature", worktree]);
  await git(worktree, ["push", "-q", "-u", "origin", "feature"]);
  const projectId = await fixture.projectIdOf(project);
  const rows = await listWorktrees(projectId);
  const row = rows.find((w) => w.path === worktree);
  assert.ok(row, "the linked worktree is listed");
  assert.equal(row.isExternal, false, "the linked worktree is managed");
  return {
    root,
    seed,
    project,
    worktree,
    id: row.id,
    projectRef: { id: projectId, name: basename(project), path: project },
  };
}

type Box = Awaited<ReturnType<typeof makeSandbox>>;

async function listedShelved(box: Box) {
  const rows = await listWorktrees(box.projectRef.id);
  const row = rows.find((w) => w.id === box.id);
  assert.ok(row, "the linked worktree is listed");
  return row.shelved;
}

// Shelve, then the listing that records the snapshot.
async function shelve(box: Box) {
  await setShelved(box.projectRef, box.id, true);
  assert.equal(
    await snapshotOf(box.id),
    undefined,
    "a shelve starts unsnapshotted",
  );
  assert.equal(await listedShelved(box), true, "shelved on first listing");
  const snapshot = await snapshotOf(box.id);
  assert.ok(snapshot, "the listing took a snapshot");
  assert.deepEqual(Object.keys(snapshot).toSorted(), ["at", "changed", "head"]);
  assert.equal(await listedShelved(box), true, "unchanged stays shelved");
  assert.deepEqual(
    await snapshotOf(box.id),
    snapshot,
    "and keeps its snapshot",
  );
  // Past the snapshot's timestamp, so an edit reads as newer than it.
  await delay(20);
  return snapshot;
}

async function assertUnshelved(box: Box) {
  assert.equal(await markedShelved(box.id), false, "the mark is gone");
  assert.equal(await snapshotOf(box.id), undefined, "the snapshot too");
}

it("an edit to a clean shelved worktree unshelves it, on the full listing only", async () => {
  const box = await makeSandbox(trackTest);
  const snapshot = await shelve(box);
  assert.equal(snapshot.changed, 0);
  assert.equal(
    snapshot.head,
    await gitOut(box.worktree, "log", "-1", "--format=%h"),
  );
  writeFileSync(join(box.worktree, "a.txt"), "edited\n");
  const [identity] = await listWorktreeIdentities({
    projectId: box.projectRef.id,
    worktreeId: box.id,
  });
  assert.ok(identity !== undefined, "the worktree's identity is listed");
  assert.equal(identity.shelved, true, "--identities settles nothing");
  assert.deepEqual(await snapshotOf(box.id), snapshot);
  assert.equal(await listedShelved(box), false);
  await assertUnshelved(box);
});

it("a new untracked file unshelves it", async () => {
  const box = await makeSandbox(trackTest);
  await shelve(box);
  writeFileSync(join(box.worktree, "new.txt"), "new\n");
  assert.equal(await listedShelved(box), false);
  await assertUnshelved(box);
});

it("changes it was shelved with keep it shelved, a new edit to one of them doesn't", async () => {
  const box = await makeSandbox(trackTest);
  writeFileSync(join(box.worktree, "a.txt"), "dirty\n");
  const snapshot = await shelve(box);
  assert.equal(snapshot.changed, 1);
  assert.equal(await listedShelved(box), true);
  writeFileSync(join(box.worktree, "a.txt"), "dirtier\n");
  assert.equal(await listedShelved(box), false);
  await assertUnshelved(box);
});

it("a deleted file unshelves it", async () => {
  const box = await makeSandbox(trackTest);
  await shelve(box);
  unlinkSync(join(box.worktree, "b.txt"));
  assert.equal(await listedShelved(box), false);
});

it("a commit unshelves it, even one that leaves the tree clean", async () => {
  const box = await makeSandbox(trackTest);
  writeFileSync(join(box.worktree, "a.txt"), "dirty\n");
  await shelve(box);
  await git(box.worktree, ["commit", "-q", "-am", "work"]);
  assert.equal(await listedShelved(box), false);
  await assertUnshelved(box);
});

it("a shelve after an unshelve starts from a fresh snapshot", async () => {
  const box = await makeSandbox(trackTest);
  await shelve(box);
  writeFileSync(join(box.worktree, "a.txt"), "edited\n");
  assert.equal(await listedShelved(box), false);
  await shelve(box);
  assert.equal(await listedShelved(box), true);
});

it("an auto-pull worktree stays shelved through a fast-forward, not through a commit", async () => {
  const box = await makeSandbox(trackTest);
  await setAutoPull(box.projectRef, box.id, true);
  await shelve(box);
  await git(box.seed, ["fetch", "-q", "origin"]);
  await git(box.seed, ["checkout", "-q", "feature"]);
  await commitFile(box.seed, "remote.txt", "remote\n", "remote");
  await git(box.seed, ["push", "-q", "origin", "feature"]);
  await git(box.worktree, ["fetch", "-q"]);
  const outcome = await autoPullWorktree(
    { path: box.worktree, detached: false },
    { busy: false },
  );
  assert.equal(outcome.kind, "pulled");
  assert.equal(await listedShelved(box), true, "the pull is not work");
  writeFileSync(join(box.worktree, "a.txt"), "local\n");
  await git(box.worktree, ["commit", "-q", "-am", "local"]);
  assert.equal(await listedShelved(box), false, "the commit is");
  await assertUnshelved(box);
});

it("a listing that read the snapshot before a reshelve leaves the reshelve alone", async () => {
  const box = await makeSandbox(trackTest);
  await shelve(box);
  // Work the first shelf's snapshot would count.
  writeFileSync(join(box.worktree, "a.txt"), "edited\n");
  // Holds the first `git status` that starts while `pause` exists
  // until `resume` does: a listing that has read the registry and
  // not yet written it. git runs the fsmonitor hook on every
  // status, and a failing one only means a full scan.
  const pause = join(box.root, "pause");
  const paused = join(box.root, "paused");
  const resume = join(box.root, "resume");
  const hook = join(box.root, "fsmonitor.sh");
  writeFileSync(
    hook,
    `#!/bin/sh\nif rm "${pause}" 2>/dev/null; then\n  : > "${paused}"\n` +
      `  while [ ! -e "${resume}" ]; do sleep 0.02; done\nfi\nexit 1\n`,
    { mode: 0o755 },
  );
  await git(box.project, ["config", "core.fsmonitor", hook]);
  writeFileSync(pause, "");
  const stale = listWorktrees(box.projectRef.id);
  trackTest(() => writeFileSync(resume, ""));
  await waitFor(() => existsSync(paused), "the listing to pause");
  // Unshelve, shelve again, and the listing that snapshots the new
  // shelf, all while the first listing holds the old snapshot.
  await setShelved(box.projectRef, box.id, false);
  await setShelved(box.projectRef, box.id, true);
  assert.equal(await listedShelved(box), true);
  const fresh = await snapshotOf(box.id);
  assert.ok(fresh, "the new shelf has its snapshot");
  writeFileSync(resume, "");
  const row = (await stale).find((w) => w.id === box.id);
  assert.equal(row?.shelved, true, "the stale listing kept it shelved");
  assert.equal(await markedShelved(box.id), true);
  assert.deepEqual(await snapshotOf(box.id), fresh);
});

it("with autoShelveDays set, an untouched worktree goes on the shelf, and an unshelve or a move of HEAD counts as a touch", async () => {
  const box = await makeSandbox(trackTest);
  await sm("config", "set", "autoShelveDays", "1");
  trackTest(() => sm("config", "unset", "autoShelveDays"));
  assert.equal(await listedShelved(box), false, "a new worktree is fresh");
  // Its newest commit, HEAD's last move and its creation two days back.
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await git(box.worktree, [
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "old",
    `--date=${old.toISOString()}`,
  ]);
  const adminDir = await gitOut(box.worktree, "rev-parse", "--git-dir");
  const age = () => {
    utimesSync(join(adminDir, "commondir"), old, old);
    utimesSync(join(adminDir, "logs", "HEAD"), old, old);
  };
  age();
  assert.equal(await listedShelved(box), true, "idle goes on the shelf");
  assert.equal(await markedShelved(box.id), true);
  assert.ok(await snapshotOf(box.id), "with its snapshot");
  await setShelved(box.projectRef, box.id, false);
  assert.equal(await listedShelved(box), false, "the unshelve is a touch");
  await shelve(box);
  writeFileSync(join(box.worktree, "a.txt"), "edited\n");
  assert.equal(await listedShelved(box), false, "work still unshelves it");
  // Clean and old again, as if that work were long past, then a switch
  // to a new branch on the same old commit: the move of HEAD is the
  // touch.
  await git(box.worktree, ["checkout", "-q", "--", "a.txt"]);
  await Engine.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM unshelved_at WHERE worktree_id = ${box.id}`;
    }),
  );
  age();
  await git(box.worktree, ["checkout", "-q", "-b", "old"]);
  assert.equal(await listedShelved(box), false, "a branch switch is a touch");
});
