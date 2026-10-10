// Durable proof for auto-pull (host/lib/worktrees/autoPullSweep.ts)
// against a REAL git repository with a remote: a marked worktree that
// is clean and strictly behind fast-forwards, and every state that
// makes a pull anything other than a plain fast-forward leaves the
// worktree untouched: a local commit, a modified file, an untracked
// file, a detached HEAD, a missing upstream, an app-started script.
// The sweep is checked to pull only the marked worktree of a project,
// and the mark (the engine's, `sm worktrees autopull`) to round-trip
// through a sandbox store and back out on the identities the
// sweep reads.
//
// Runs on the engine in-process, beside the terminal sm on the same
// store (test/lib/smBinary.mts).
// Run: pnpm test auto-pull.
import assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { promised } from "./lib/gitPromises.mts";
import { sandboxGit, scrubbedGitEnv } from "./lib/checkKit.mts";
import { scrubProcessGitEnv, tempDir, type Track } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { addProject, wireHostCli } from "./lib/smBinary.mts";

// The pull runs git under this process's environment. The pre-commit
// hook's GIT_* variables would point that git at the commit in
// progress, so they go before anything is imported.
const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv();

let dataDir: string;
let wired: Awaited<ReturnType<typeof wireHostCli>>;
const sm: typeof wired.sm = (...args) => wired.sm(...args);
beforeAll(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "sm-auto-pull-data-")));
  wired = await wireHostCli(dataDir);
});
afterAll(async () => {
  await wired.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const { autoPullWorktree, sweepAutoPull } = promised(
  await import("../host/lib/worktrees/autoPullSweep.ts"),
);
const Ops = await import("../host/lib/engineOps.ts");
const { onSandboxEngine } = await import("./lib/sandboxEngine.mts");
const listWorktreeIdentities = (
  ...args: Parameters<typeof Ops.listWorktreeIdentities>
) => onSandboxEngine(Ops.listWorktreeIdentities(...args));
const setAutoPull = (...args: Parameters<typeof Ops.setAutoPull>) =>
  onSandboxEngine(Ops.setAutoPull(...args));
// The sweep over the project's checkouts as the fetch reads them.
const sweepProject = async (projectId: string, busy: ReadonlySet<string>) =>
  sweepAutoPull(await listWorktreeIdentities({ projectId }), busy);

const git = sandboxGit(gitEnv);

const decodeMarks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ id: Schema.String, autoPull: Schema.Boolean })),
);

// The marked ids as the terminal sm reads them from the store, another
// process than the app's.
async function markedInStore(): Promise<string[]> {
  const { docs } = await sm("worktrees", "list", "--identities", "--all");
  const rows = decodeMarks(docs.at(-1));
  return rows
    .filter((row) => row.autoPull)
    .map((row) => row.id)
    .toSorted();
}

// A bare origin, a "project" clone whose main follows origin/main, and
// a second clone that plays the colleague pushing new commits.
function makeSandbox(track: Track) {
  const root = tempDir("sm-auto-pull-", track);
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-b", "main", origin);
  // init + remote rather than a clone of the empty origin, which git
  // warns about on stderr.
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "remote", "add", "origin", origin);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "-u", "origin", "main");
  const project = join(root, "project");
  git(root, "clone", "-q", origin, project);
  return { root, origin, seed, project };
}

function pushCommit(seed: string, name: string) {
  writeFileSync(join(seed, name), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", name);
  git(seed, "push", "-q", "origin", "HEAD");
}

const head = (cwd: string) => git(cwd, "rev-parse", "HEAD").trim();

it("a clean worktree strictly behind its upstream fast-forwards", async () => {
  const { seed, project } = makeSandbox(trackTest);
  pushCommit(seed, "one.txt");
  pushCommit(seed, "two.txt");
  git(project, "fetch", "-q");
  const outcome = await autoPullWorktree(
    { path: project, detached: false },
    { busy: false },
  );
  assert.deepEqual(outcome, { kind: "pulled", commits: 2 });
  assert.equal(head(project), head(seed));
  assert.equal(git(project, "status", "--porcelain").trim(), "");
});

it("a worktree already at its upstream is left alone", async () => {
  const { project } = makeSandbox(trackTest);
  const outcome = await autoPullWorktree(
    { path: project, detached: false },
    { busy: false },
  );
  assert.deepEqual(outcome, { kind: "skipped", reason: "synced" });
});

it("a local commit stops the pull, even with the upstream ahead", async () => {
  const { seed, project } = makeSandbox(trackTest);
  pushCommit(seed, "remote.txt");
  writeFileSync(join(project, "local.txt"), "local\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "local");
  git(project, "fetch", "-q");
  const before = head(project);
  const outcome = await autoPullWorktree(
    { path: project, detached: false },
    { busy: false },
  );
  assert.deepEqual(outcome, { kind: "skipped", reason: "ahead" });
  assert.equal(head(project), before);
});

it("a modified tracked file stops the pull", async () => {
  const { seed, project } = makeSandbox(trackTest);
  pushCommit(seed, "remote.txt");
  git(project, "fetch", "-q");
  writeFileSync(join(project, "README.md"), "edited\n");
  const before = head(project);
  const outcome = await autoPullWorktree(
    { path: project, detached: false },
    { busy: false },
  );
  assert.deepEqual(outcome, { kind: "skipped", reason: "dirty" });
  assert.equal(head(project), before);
});

it("an untracked file stops the pull, whatever the untracked-files setting", async () => {
  const { seed, project } = makeSandbox(trackTest);
  pushCommit(seed, "remote.txt");
  git(project, "fetch", "-q");
  git(project, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(project, "scratch.txt"), "scratch\n");
  const before = head(project);
  const outcome = await autoPullWorktree(
    { path: project, detached: false },
    { busy: false },
  );
  assert.deepEqual(outcome, { kind: "skipped", reason: "dirty" });
  assert.equal(head(project), before);
});

it("a detached HEAD and a missing upstream are skipped", async () => {
  const { seed, project } = makeSandbox(trackTest);
  pushCommit(seed, "remote.txt");
  git(project, "fetch", "-q");
  assert.deepEqual(
    await autoPullWorktree({ path: project, detached: true }, { busy: false }),
    { kind: "skipped", reason: "detached" },
  );
  git(project, "checkout", "-q", "-b", "unpublished");
  assert.deepEqual(
    await autoPullWorktree({ path: project, detached: false }, { busy: false }),
    { kind: "skipped", reason: "no-upstream" },
  );
});

it("a worktree with an app-started script is skipped", async () => {
  const { seed, project } = makeSandbox(trackTest);
  pushCommit(seed, "remote.txt");
  git(project, "fetch", "-q");
  const before = head(project);
  const outcome = await autoPullWorktree(
    { path: project, detached: false },
    { busy: true },
  );
  assert.deepEqual(outcome, { kind: "skipped", reason: "busy" });
  assert.equal(head(project), before);
});

it("the mark round-trips through the store and drops cleanly", async () => {
  const { project, root } = makeSandbox(trackTest);
  const linked = join(root, "linked");
  git(project, "worktree", "add", "-q", "-b", "feature", linked);
  const registered = await addProject(sm, project);
  const ids = async () =>
    Object.fromEntries(
      (await listWorktreeIdentities({ projectId: registered.id })).map(
        (identity) => [identity.path, identity],
      ),
    );
  const before = await ids();
  const primaryBefore = before[project];
  const linkedBefore = before[linked];
  assert.ok(primaryBefore !== undefined, "the primary worktree is listed");
  assert.ok(linkedBefore !== undefined, "the linked worktree is listed");
  assert.equal(primaryBefore.autoPull, false);
  const primaryId = primaryBefore.id;
  const linkedId = linkedBefore.id;
  const row = await setAutoPull(registered, primaryId, true);
  assert.equal(row.autoPull, true, "the answered row carries the mark");
  await setAutoPull(registered, linkedId, true);
  assert.deepEqual(await markedInStore(), [linkedId, primaryId].toSorted());
  assert.equal((await ids())[project]?.autoPull, true);
  await setAutoPull(registered, primaryId, false);
  await setAutoPull(registered, primaryId, false);
  assert.deepEqual(await markedInStore(), [linkedId]);
  await setAutoPull(registered, linkedId, false);
  assert.deepEqual(await markedInStore(), []);
});

it("the sweep pulls only the marked worktree of a project and reports the rest untouched", async () => {
  const { seed, project, root } = makeSandbox(trackTest);
  // A linked worktree on its own upstream branch, unmarked.
  const linked = join(root, "linked");
  git(project, "worktree", "add", "-q", "-b", "feature", linked);
  git(linked, "push", "-q", "-u", "origin", "feature");
  pushCommit(seed, "remote.txt");
  git(seed, "fetch", "-q", "origin");
  git(seed, "checkout", "-q", "feature");
  pushCommit(seed, "feature.txt");
  git(project, "fetch", "-q");
  git(linked, "fetch", "-q");
  const linkedBefore = head(linked);
  const registered = await addProject(sm, project);
  // Nothing marked: nothing happens.
  let result = await sweepProject(registered.id, new Set());
  assert.deepEqual(result, { pulled: [], failed: [] });
  const [primary] = await listWorktreeIdentities({
    projectId: registered.id,
  });
  assert.ok(primary !== undefined, "the project lists its primary worktree");
  assert.equal(primary.path, project);
  await setAutoPull(registered, primary.id, true);
  result = await sweepProject(registered.id, new Set());
  assert.equal(result.failed.length, 0);
  assert.deepEqual(
    result.pulled.map((entry) => [entry.worktree.path, entry.commits]),
    [[project, 1]],
  );
  assert.equal(head(project), git(seed, "rev-parse", "main").trim());
  assert.equal(head(linked), linkedBefore, "the unmarked worktree moved");
  // Busy worktrees are the caller's to name, and are left alone.
  pushCommit(seed, "feature-two.txt");
  git(seed, "checkout", "-q", "main");
  pushCommit(seed, "main-two.txt");
  git(project, "fetch", "-q");
  result = await sweepProject(registered.id, new Set([primary.id]));
  assert.deepEqual(result, { pulled: [], failed: [] });
});
