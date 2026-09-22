// Durable proof for auto-pull (host/lib/worktrees/autoPull.ts and
// autoPullSweep.ts) against a REAL git repository with a remote: a
// marked worktree that is clean and strictly behind fast-forwards, and
// every state that makes a pull anything other than a plain
// fast-forward leaves the worktree untouched: a local commit, a
// modified file, an untracked file, a detached HEAD, a missing
// upstream, an app-started script. The sweep is checked to pull only
// the marked worktree of a project, and the mark storage to round-trip
// through a sandbox registry.json.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test auto-pull.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProof, sandboxGit, scrubbedGitEnv } from "./lib/checkKit.mjs";

// The pull runs git under this process's environment. The pre-commit
// hook's GIT_* variables would point that git at the commit in
// progress, so they go before anything is imported.
const gitEnv = scrubbedGitEnv();
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const { initDataDirAt } = await import("../host/lib/util/paths.ts");
const { isAutoPull, readAutoPullSet, setAutoPull, dropAutoPull } =
  await import("../host/lib/worktrees/autoPull.ts");
const { autoPullWorktree, sweepAutoPull } =
  await import("../host/lib/worktrees/autoPullSweep.ts");
const { worktreeIdFromPath } = await import("../host/lib/git/worktrees.ts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("auto-pull proof");

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "sm-auto-pull-data-")));
initDataDirAt(dataDir);

// A bare origin, a "project" clone whose main follows origin/main, and
// a second clone that plays the colleague pushing new commits.
function makeSandbox(track) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-auto-pull-")));
  track(() => rmSync(root, { recursive: true, force: true }));
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

function pushCommit(seed, name) {
  writeFileSync(join(seed, name), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", name);
  git(seed, "push", "-q", "origin", "HEAD");
}

const head = (cwd) => git(cwd, "rev-parse", "HEAD").trim();

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
    () => {
      assert.equal(isAutoPull("wt-a"), false);
      setAutoPull("wt-a", true);
      setAutoPull("wt-b", true);
      assert.equal(isAutoPull("wt-a"), true);
      assert.deepEqual([...readAutoPullSet()].toSorted(), ["wt-a", "wt-b"]);
      dropAutoPull("wt-a");
      dropAutoPull("wt-a");
      assert.deepEqual([...readAutoPullSet()], ["wt-b"]);
      dropAutoPull("wt-b");
      assert.equal(readAutoPullSet().size, 0);
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
      // Nothing marked: nothing happens, no git spawned for it.
      let result = await sweepAutoPull("proj", project, new Set());
      assert.deepEqual(result, { pulled: [], failed: [] });
      const projectId = worktreeIdFromPath(project);
      setAutoPull(projectId, true);
      track(() => dropAutoPull(projectId));
      result = await sweepAutoPull("proj", project, new Set());
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
      result = await sweepAutoPull("proj", project, new Set([projectId]));
      assert.deepEqual(result, { pulled: [], failed: [] });
    },
  );

  rmSync(dataDir, { recursive: true, force: true });
  done();
}

main().catch(fail);
