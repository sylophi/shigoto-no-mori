// The Git service against real repositories: the runner, worktrees,
// history, refs, the default ref, the remote sync and its guards,
// clone, and the diffs.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommitSummary } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { it } from "vitest";
import {
  BranchNotMergedError,
  CloneDestinationError,
  GitCommandError,
  GitOutputTooLargeError,
  NoRemoteError,
  OverwriteRefusedError,
  stderrOf,
} from "../src/Git.ts";
import { LOG_FORMAT, parseLog } from "../src/gitParse.ts";
import {
  failureAs,
  failureOf,
  git,
  rev,
  seedRepo,
  tempDir,
  withGit,
  write,
} from "./sandbox.ts";

// A repository, a bare remote it pushed main to, and a clone of that.
function withRemote() {
  const remote = tempDir("remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const repo = seedRepo();
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  const parent = tempDir("clones-");
  git(parent, "clone", "-q", remote, "clone");
  return { remote, repo, clone: join(parent, "clone") };
}

// --- the runner -----------------------------------------------------

it("a failure carries git's own words, in English, and its exit code", async () => {
  const repo = seedRepo();
  const error = await failureAs(GitCommandError, (g) =>
    g.run(repo, ["-c", "x.y=z", "checkout", "no-such-branch"]),
  );
  assert.equal(error.subcommand, "checkout");
  assert.equal(error.exitCode, 1);
  assert.match(stderrOf(error), /did not match any file\(s\) known to git/);
  assert.equal(error.message, "git checkout exited with 1.");
});

it("output past the cap is an error, not a prefix", async () => {
  const repo = seedRepo();
  await failureAs(GitOutputTooLargeError, (g) =>
    g.run(repo, ["log"], { maxOutputBytes: 10 }),
  );
});

it("feeds stdin, layers env, and accepts the exit codes it is told to", async () => {
  const repo = seedRepo();
  const head = rev(repo, "HEAD");
  const checked = await withGit((g) =>
    g.run(repo, ["cat-file", "--batch-check"], { stdin: `${head}\nnope\n` }),
  );
  assert.match(checked, new RegExp(`^${head} commit`));
  assert.match(checked, /nope missing/);
  const name = await withGit((g) =>
    g.run(repo, ["var", "GIT_AUTHOR_IDENT"], {
      env: { GIT_AUTHOR_NAME: "layered" },
    }),
  );
  assert.match(name, /^layered /);
  write(repo, "x.txt", "x\n");
  const diff = await withGit((g) =>
    g.run(repo, ["diff", "--no-index", "/dev/null", "x.txt"], {
      okExitCodes: [1],
    }),
  );
  assert.match(diff, /\+x/);
});

it("an interrupted run takes its git down with it, hooks and all", async () => {
  const repo = seedRepo();
  const pidFile = join(repo, "hook.pid");
  write(
    repo,
    ".git/hooks/pre-commit",
    `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 60\n`,
  );
  chmodSync(join(repo, ".git/hooks/pre-commit"), 0o755);
  const outcome = await withGit((g) =>
    g
      .run(repo, ["commit", "-q", "--allow-empty", "-m", "slow"])
      .pipe(Effect.timeout("500 millis"), Effect.exit),
  );
  assert.ok(Exit.isFailure(outcome));
  const hook = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(hook, 0), /ESRCH/);
});

// --- worktrees ------------------------------------------------------

it("lists, adds, checks out and removes worktrees", async () => {
  const repo = seedRepo();
  const parent = tempDir("wts-");
  const feat = join(parent, "feat");
  await withGit((g) => g.addWorktree({ repo, path: feat, branch: "feat" }));
  git(feat, "checkout", "-q", "--detach");
  git(repo, "worktree", "lock", feat);
  const listed = await withGit((g) => g.listWorktrees(repo));
  assert.deepEqual(
    listed.map((e) => [basename(e.path), e.branch, e.detached, e.locked]),
    [
      [basename(repo), "refs/heads/main", false, false],
      ["feat", "", true, true],
    ],
  );
  git(repo, "worktree", "unlock", feat);
  write(feat, "dirty.txt", "x\n");
  git(repo, "config", "status.showUntrackedFiles", "no");
  // The untracked file counts even with the user's setting off.
  await failureAs(GitCommandError, (g) =>
    g.removeWorktree({ repo, path: feat, force: false }),
  );
  await withGit((g) => g.removeWorktree({ repo, path: feat, force: true }));
  assert.equal(existsSync(feat), false);
});

it("a checkout of a remote ref lands on a tracking branch, never a detached HEAD", async () => {
  const { repo: upstream } = withRemote();
  git(upstream, "branch", "feat");
  git(upstream, "branch", "remote-only");
  git(upstream, "push", "-q", "origin", "feat", "remote-only");
  const parent = tempDir("checkout-");
  const remote = git(upstream, "remote", "get-url", "origin").trim();
  const repo = join(parent, "repo");
  git(parent, "clone", "-q", remote, repo);
  git(repo, "checkout", "-q", "-b", "scratch");
  git(repo, "branch", "--no-track", "local-only");
  git(repo, "branch", "--track", "feat", "origin/feat");

  const cases = [
    ["origin/main", "main", "origin/main"],
    ["origin/feat", "feat", "origin/feat"],
    ["origin/remote-only", "remote-only", "origin/remote-only"],
    ["local-only", "local-only", ""],
  ] as const;
  for (const [i, [ref, branch, upstreamRef]] of cases.entries()) {
    const path = join(parent, `wt${i}`);
    // oxlint-disable-next-line no-await-in-loop -- one worktree add at a time, as the repo's lock wants
    await withGit((g) => g.checkoutWorktree({ repo, path, ref }));
    assert.equal(
      git(path, "symbolic-ref", "--short", "HEAD").trim(),
      branch,
      ref,
    );
    let tracking = "";
    try {
      tracking = git(
        path,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ).trim();
    } catch {
      // No upstream.
    }
    assert.equal(tracking, upstreamRef, ref);
  }
});

// --- history --------------------------------------------------------

it("parses the log fixture the CLI's parser is held to", () => {
  const fixture: {
    format: string;
    cases: { name: string; stdout: string; commits: CommitSummary[] }[];
  } = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../app/shared/fixtures/git-log.json"),
      "utf8",
    ),
  );
  assert.equal(LOG_FORMAT, fixture.format);
  for (const { name, stdout, commits } of fixture.cases) {
    assert.deepEqual(parseLog(stdout), commits, name);
  }
});

it("a crafted subject in a real repo stays one commit", async () => {
  const repo = seedRepo();
  const crafted = "evil\x01NOTAHASH\tx\ty\tinjected";
  git(repo, "commit", "-q", "--allow-empty", "-m", crafted);
  const commits = await withGit((g) =>
    g.listCommits(repo, { skip: 0, count: 10 }),
  );
  assert.deepEqual(
    commits.map((c) => c.subject),
    [crafted, "init"],
  );
  assert.deepEqual(
    await withGit((g) => g.listCommits(tempDir(), { skip: 0, count: 10 })),
    [],
  );
});

it("measures a branch against its upstream and the remotes", async () => {
  const { clone } = withRemote();
  assert.deepEqual(await withGit((g) => g.upstreamSync(clone)), {
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    divergedClean: false,
  });
  write(clone, "mine.txt", "mine\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "mine");
  assert.equal(await withGit((g) => g.unpushedCount(clone)), 1);
  // The upstream moves on without touching mine.txt: diverged, cleanly.
  git(clone, "push", "-q", "origin", "HEAD:refs/heads/other");
  git(clone, "branch", "-q", "theirs", "HEAD~1");
  git(clone, "checkout", "-q", "theirs");
  write(clone, "theirs.txt", "theirs\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "theirs");
  git(clone, "push", "-q", "-f", "origin", "HEAD:main");
  git(clone, "checkout", "-q", "main");
  git(clone, "fetch", "-q");
  assert.deepEqual(await withGit((g) => g.upstreamSync(clone)), {
    ahead: 1,
    behind: 1,
    hasUpstream: true,
    divergedClean: true,
  });
  git(clone, "checkout", "-q", "-b", "untracked-branch");
  assert.equal(
    (await withGit((g) => g.upstreamSync(clone))).hasUpstream,
    false,
  );
  assert.ok(
    Option.isNone(await withGit((g) => g.aheadBehind(clone, "no-such-ref"))),
  );
});

it("tells a branch merged into the primary from one that never left it", async () => {
  const repo = seedRepo();
  const relation = (worktree: string) =>
    withGit((g) =>
      g.primaryRelation({
        worktree,
        primaryRef: "main",
        chain: g.firstParentChain(repo, "main"),
      }),
    );
  const parent = tempDir("rel-");
  const idle = join(parent, "idle");
  const merged = join(parent, "merged");
  git(repo, "worktree", "add", "-q", "-b", "idle", idle);
  git(repo, "worktree", "add", "-q", "-b", "merged", merged);
  write(merged, "m.txt", "m\n");
  git(merged, "add", ".");
  git(merged, "commit", "-q", "-m", "work");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge", "merged");
  assert.deepEqual(await relation(idle), {
    behindPrimary: 2,
    mergedIntoPrimary: false,
  });
  assert.deepEqual(await relation(merged), {
    behindPrimary: 1,
    mergedIntoPrimary: true,
  });
});

// --- refs and branches ----------------------------------------------

it("reads, moves and compares refs", async () => {
  const repo = seedRepo();
  const head = rev(repo, "HEAD");
  write(repo, "a.txt", "2\n");
  git(repo, "commit", "-qam", "two");
  const two = rev(repo, "HEAD");
  await withGit((g) =>
    g.updateRef({
      repo,
      ref: "refs/x/y",
      commit: head,
      expected: "0".repeat(40),
    }),
  );
  assert.ok(Option.isSome(await withGit((g) => g.refTip(repo, "refs/x/y"))));
  // The compare-and-set refuses a ref that moved.
  await failureAs(GitCommandError, (g) =>
    g.updateRef({ repo, ref: "refs/x/y", commit: two, expected: two }),
  );
  await withGit((g) => g.deleteRef(repo, "refs/x/y"));
  assert.ok(Option.isNone(await withGit((g) => g.refTip(repo, "refs/x/y"))));
  assert.equal(await withGit((g) => g.isAncestor(repo, head, two)), true);
  assert.equal(await withGit((g) => g.isAncestor(repo, two, head)), false);
  await failureAs(GitCommandError, (g) => g.isAncestor(repo, "nope", two));
  assert.equal(await withGit((g) => g.hasCommit(repo, head)), true);
  assert.equal(await withGit((g) => g.hasCommit(repo, "0".repeat(40))), false);
  assert.equal(
    await withGit((g) => g.treeOf(repo, two)),
    rev(repo, `${two}^{tree}`),
  );
});

it("a safe delete of an unmerged branch says so, and the forced one goes through", async () => {
  const repo = seedRepo();
  git(repo, "checkout", "-q", "-b", "feat");
  write(repo, "f.txt", "f\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "f");
  git(repo, "checkout", "-q", "main");
  const error = await failureAs(BranchNotMergedError, (g) =>
    g.deleteBranch({ repo, name: "feat", force: false }),
  );
  assert.equal(error.message, "Branch 'feat' has unmerged commits.");
  await withGit((g) => g.deleteBranch({ repo, name: "feat", force: true }));
  assert.equal(await withGit((g) => g.localBranchExists(repo, "feat")), false);
});

it("creates a branch tracking a remote base, never a local one", async () => {
  const { clone } = withRemote();
  git(clone, "branch", "feature/base");
  await withGit((g) =>
    g.createBranch({ repo: clone, name: "from-remote", base: "origin/main" }),
  );
  await withGit((g) =>
    g.createBranch({ repo: clone, name: "from-local", base: "feature/base" }),
  );
  assert.equal(
    git(clone, "config", "branch.from-remote.merge").trim(),
    "refs/heads/main",
  );
  assert.throws(() => git(clone, "config", "branch.from-local.merge"));
  assert.deepEqual(await withGit((g) => g.listBranches(clone)), {
    local: ["feature/base", "from-local", "from-remote", "main"],
    remote: ["origin/main"],
  });
});

it("the default ref prefers the candidates, and falls back to a remote's HEAD", async () => {
  const { remote, repo } = withRemote();
  git(repo, "push", "-q", "origin", "main:trunk");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
  git(remote, "branch", "-D", "main");
  const parent = tempDir("default-");
  git(parent, "clone", "-q", remote, "c");
  const clone = join(parent, "c");
  assert.deepEqual(
    await withGit((g) => g.resolveDefaultRef(clone)),
    Option.some("refs/remotes/origin/trunk"),
  );
  // A local main is a candidate, so it wins over the remote HEAD.
  git(clone, "branch", "main");
  assert.deepEqual(
    await withGit((g) => g.resolveDefaultRef(clone)),
    Option.some("refs/heads/main"),
  );
  assert.deepEqual(
    await withGit((g) => g.resolveDefaultBranch(clone)),
    Option.some("main"),
  );
  // An override names any branch there is, local or remote.
  assert.deepEqual(
    await withGit((g) => g.resolveDefaultRef(clone, " origin/trunk ")),
    Option.some("refs/remotes/origin/trunk"),
  );
  // No candidate and no remote: no ref for identity, but the first
  // local branch still makes a merge target.
  const lone = tempDir("lone-");
  git(lone, "init", "-q", "-b", "work");
  git(lone, "commit", "-q", "--allow-empty", "-m", "x");
  assert.ok(Option.isNone(await withGit((g) => g.resolveDefaultRef(lone))));
  assert.deepEqual(
    await withGit((g) => g.resolveDefaultBranch(lone)),
    Option.some("work"),
  );
});

it("reads the ignore rules a worktree is under, anchored at the root", async () => {
  const repo = seedRepo();
  write(repo, ".gitignore", "# comment\n*.log\n\n/build\n");
  write(repo, "pkg/.gitignore", "dist/\nsrc/gen\n!keep.log\n");
  write(repo, ".git/info/exclude", ".env\n");
  assert.deepEqual(await withGit((g) => g.listIgnoreRules(repo)), [
    "*.log",
    "/build",
    "/pkg/**/dist/",
    "/pkg/src/gen",
    "!/pkg/**/keep.log",
    ".env",
  ]);
  write(repo, "x.log", "x\n");
  write(repo, "build/out", "o\n");
  assert.deepEqual(
    (await withGit((g) => g.listIgnoredPaths(repo))).toSorted(),
    ["build/", "x.log"],
  );
});

// --- the remote -----------------------------------------------------

it("overwrite from upstream refuses dirty work and ignored files in the way", async () => {
  const { repo, clone } = withRemote();
  write(repo, ".gitignore", "secret.env\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore");
  git(repo, "push", "-q");
  git(clone, "pull", "-q");
  write(clone, "local.txt", "local\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "local");
  // Upstream starts tracking a file at an ignored local path.
  git(repo, "rm", "-q", ".gitignore");
  write(repo, "secret.env", "theirs\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "track it");
  git(repo, "push", "-q");

  write(clone, "a.txt", "uncommitted\n");
  const dirty = await failureAs(OverwriteRefusedError, (g) =>
    g.overwriteFromUpstream(clone),
  );
  assert.equal(dirty.reason, "uncommitted");
  git(clone, "checkout", "-q", "--", "a.txt");

  write(clone, "secret.env", "mine\n");
  const ignored = await failureOf((g) => g.overwriteFromUpstream(clone));
  assert.equal(
    ignored.message,
    "Overwriting would replace ignored local file(s) the upstream branch tracks: secret.env. Move them aside first.",
  );
  assert.equal(readFileSync(join(clone, "secret.env"), "utf8"), "mine\n");

  rmSync(join(clone, "secret.env"));
  await withGit((g) => g.overwriteFromUpstream(clone));
  assert.equal(rev(clone, "HEAD"), rev(repo, "HEAD"));
});

it("concurrent fetches of one repository all answer", async () => {
  const { clone } = withRemote();
  const fetches = await withGit((g) =>
    Effect.all(
      Array.from({ length: 5 }, () => g.fetchAll(clone)),
      { concurrency: "unbounded" },
    ),
  );
  assert.equal(fetches.length, 5);
});

it("publish needs a remote, and pushes the branch with tracking", async () => {
  const { clone } = withRemote();
  git(clone, "checkout", "-q", "-b", "fresh");
  await withGit((g) => g.publish({ worktree: clone, repo: clone }));
  assert.equal(
    git(clone, "rev-parse", "--abbrev-ref", "fresh@{u}").trim(),
    "origin/fresh",
  );
  const lone = seedRepo();
  await failureAs(NoRemoteError, (g) =>
    g.publish({ worktree: lone, repo: lone }),
  );
});

it("clone checks its destination, and keeps a URL's userinfo out of the error", async () => {
  const { remote } = withRemote();
  const parent = tempDir("clone-into-");
  assert.equal(
    await withGit((g) =>
      g.clone({ url: remote, parentDir: parent, name: "c" }),
    ),
    join(parent, "c"),
  );
  const exists = await failureOf((g) =>
    g.clone({ url: remote, parentDir: parent, name: "c" }),
  );
  assert.equal(exists.message, `${join(parent, "c")} already exists`);
  const missing = await failureAs(CloneDestinationError, (g) =>
    g.clone({ url: remote, parentDir: join(parent, "nope"), name: "c" }),
  );
  assert.equal(missing.reason, "not-a-folder");
  const leaked = await failureAs(GitCommandError, (g) =>
    g.clone({
      url: "http://user:s3cret@127.0.0.1:9/repo.git",
      parentDir: parent,
      name: "d",
    }),
  );
  assert.doesNotMatch(stderrOf(leaked), /s3cret/);
});

// --- diffs ----------------------------------------------------------

it("diffs a tracked file, an untracked one, and refuses an ignored one", async () => {
  const repo = seedRepo();
  write(repo, ".gitignore", ".env\n");
  write(repo, ".env", "SECRET=1\n");
  write(repo, "a.txt", "changed\n");
  write(repo, "new.txt", "new\n");
  assert.match(
    await withGit((g) =>
      g.fileDiff({ worktree: repo, paths: ["a.txt"], untracked: false }),
    ),
    /\+changed/,
  );
  assert.match(
    await withGit((g) =>
      g.fileDiff({ worktree: repo, paths: ["new.txt"], untracked: true }),
    ),
    /\+new/,
  );
  assert.equal(
    await withGit((g) =>
      g.fileDiff({ worktree: repo, paths: [".env"], untracked: true }),
    ),
    "",
  );
  const head = rev(repo, "HEAD");
  assert.match(await withGit((g) => g.commitDiff(repo, head)), /\+sea/);
  assert.equal(await withGit((g) => g.commitDiff(repo, "--output=/tmp/x")), "");
});
