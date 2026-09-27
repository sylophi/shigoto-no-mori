// Durable proof for auto-pull (host/lib/worktrees/autoPullSweep.ts)
// against a REAL git repository with a remote: a marked worktree that
// is clean and strictly behind fast-forwards, and every state that
// makes a pull anything other than a plain fast-forward leaves the
// worktree untouched: a local commit, a modified file, an untracked
// file, a detached HEAD, a missing upstream, an app-started script.
// The sweep is checked to pull only the marked worktree of a project,
// and the mark (the CLI's, `sm worktrees autopull`) to round-trip
// through a sandbox registry.json and back out on the identities the
// sweep reads.
//
// Runs under test/lib/register-ts-alias.mts so the app's TypeScript
// imports resolve, against the sm binary built from cli/
// (test/lib/smBinary.mts). Run: pnpm test auto-pull.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProof, sandboxGit, scrubbedGitEnv } from "./lib/checkKit.mts";
import { scrubProcessGitEnv, tempDir, type Track } from "./lib/checkKit.mts";
import { addProject, wireHostCli } from "./lib/smBinary.mts";

// The pull runs git under this process's environment. The pre-commit
// hook's GIT_* variables would point that git at the commit in
// progress, so they go before anything is imported.
const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv();

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "sm-auto-pull-data-")));
const { sm } = await wireHostCli(dataDir);

const { autoPullWorktree, sweepAutoPull } =
  await import("../host/lib/worktrees/autoPullSweep.ts");
const { listWorktreeIdentitiesViaCli, setAutoPullViaCli } =
  await import("../host/ipc/cliDelegate.ts");
// Loads host modules too, so it waits for the scrub like they do.
const { readRegistry } = await import("./lib/cliSandbox.mts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("auto-pull proof");

// The marked ids registry.json holds under the CLI's key.
function markedInRegistry() {
  const registry = readRegistry(dataDir);
  return Object.keys(registry.autoPullWorktrees ?? {}).toSorted();
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

async function main() {
  console.log("auto-pull proof\n");

  await check(
    "a clean worktree strictly behind its upstream fast-forwards",
    async (track) => {
      const { seed, project } = makeSandbox(track);
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
    },
  );

  await check(
    "a worktree already at its upstream is left alone",
    async (track) => {
      const { project } = makeSandbox(track);
      const outcome = await autoPullWorktree(
        { path: project, detached: false },
        { busy: false },
      );
      assert.deepEqual(outcome, { kind: "skipped", reason: "synced" });
    },
  );

  await check(
    "a local commit stops the pull, even with the upstream ahead",
    async (track) => {
      const { seed, project } = makeSandbox(track);
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
    },
  );

  await check("a modified tracked file stops the pull", async (track) => {
    const { seed, project } = makeSandbox(track);
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

  await check(
    "an untracked file stops the pull, whatever the untracked-files setting",
    async (track) => {
      const { seed, project } = makeSandbox(track);
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
    },
  );

  await check(
    "a detached HEAD and a missing upstream are skipped",
    async (track) => {
      const { seed, project } = makeSandbox(track);
      pushCommit(seed, "remote.txt");
      git(project, "fetch", "-q");
      assert.deepEqual(
        await autoPullWorktree(
          { path: project, detached: true },
          { busy: false },
        ),
        { kind: "skipped", reason: "detached" },
      );
      git(project, "checkout", "-q", "-b", "unpublished");
      assert.deepEqual(
        await autoPullWorktree(
          { path: project, detached: false },
          { busy: false },
        ),
        { kind: "skipped", reason: "no-upstream" },
      );
    },
  );

  await check(
    "a worktree with an app-started script is skipped",
    async (track) => {
      const { seed, project } = makeSandbox(track);
      pushCommit(seed, "remote.txt");
      git(project, "fetch", "-q");
      const before = head(project);
      const outcome = await autoPullWorktree(
        { path: project, detached: false },
        { busy: true },
      );
      assert.deepEqual(outcome, { kind: "skipped", reason: "busy" });
      assert.equal(head(project), before);
    },
  );

  await check(
    "the mark round-trips through registry.json and drops cleanly",
    async (track) => {
      const { project, root } = makeSandbox(track);
      const linked = join(root, "linked");
      git(project, "worktree", "add", "-q", "-b", "feature", linked);
      const registered = await addProject(sm, project);
      const ids = async () =>
        Object.fromEntries(
          (
            await listWorktreeIdentitiesViaCli({ projectId: registered.id })
          ).map((identity) => [identity.path, identity]),
        );
      const before = await ids();
      const primaryBefore = before[project];
      const linkedBefore = before[linked];
      assert.ok(primaryBefore !== undefined, "the primary worktree is listed");
      assert.ok(linkedBefore !== undefined, "the linked worktree is listed");
      assert.equal(primaryBefore.autoPull, false);
      const primaryId = primaryBefore.id;
      const linkedId = linkedBefore.id;
      const row = await setAutoPullViaCli(registered, primaryId, true);
      assert.equal(row.autoPull, true, "the answered row carries the mark");
      await setAutoPullViaCli(registered, linkedId, true);
      assert.deepEqual(markedInRegistry(), [linkedId, primaryId].toSorted());
      assert.equal((await ids())[project]?.autoPull, true);
      await setAutoPullViaCli(registered, primaryId, false);
      await setAutoPullViaCli(registered, primaryId, false);
      assert.deepEqual(markedInRegistry(), [linkedId]);
      await setAutoPullViaCli(registered, linkedId, false);
      assert.deepEqual(markedInRegistry(), []);
    },
  );

  await check(
    "the sweep pulls only the marked worktree of a project and reports the rest untouched",
    async (track) => {
      const { seed, project, root } = makeSandbox(track);
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
      let result = await sweepAutoPull(registered.id, new Set());
      assert.deepEqual(result, { pulled: [], failed: [] });
      const [primary] = await listWorktreeIdentitiesViaCli({
        projectId: registered.id,
      });
      assert.ok(
        primary !== undefined,
        "the project lists its primary worktree",
      );
      assert.equal(primary.path, project);
      await setAutoPullViaCli(registered, primary.id, true);
      result = await sweepAutoPull(registered.id, new Set());
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
      result = await sweepAutoPull(registered.id, new Set([primary.id]));
      assert.deepEqual(result, { pulled: [], failed: [] });
    },
  );

  rmSync(dataDir, { recursive: true, force: true });
  done();
}

main().catch(fail);
