// The Git service against real repositories: the runner, worktrees,
// history, refs, the default ref, the remote sync and its guards,
// clone, and the diffs.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { basename, join } from "node:path";
import type { CommitSummary } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { it, vi } from "vitest";
import {
  BranchMovedError,
  BranchNotMergedError,
  CloneDestinationError,
  GitCommandError,
  GitOutputTooLargeError,
  GitRefusedError,
  NoRemoteError,
  stderrOf,
  UnknownRevisionError,
} from "../src/Git.ts";
import type * as Git from "../src/Git.ts";
import { SPAWN_SLOTS } from "../src/git/documents.ts";
import { LOG_FORMAT, parseLog } from "../src/gitParse.ts";
import {
  failureAs,
  failureOf,
  git,
  realClone,
  rev,
  seedRepo,
  tempDir,
  withGit,
  write,
} from "./lib/gitRepos.ts";

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

// Each git's exit, as GIT_TRACE2_EVENT traced it to `trace`.
const exits = (trace: string) =>
  existsSync(trace)
    ? readFileSync(trace, "utf8")
        .split("\n")
        .filter((line) => line.includes('"event":"exit"')).length
    : 0;

it("a write waits out the moment another git holds index.lock, and fails on one held for good", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "staged\n");
  git(repo, "add", "a.txt");
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  const waiting = join(tempDir("trace-"), "waiting");
  const outcome = await withGit((g) =>
    Effect.gen(function* () {
      const resetting = yield* Effect.forkChild(
        Effect.exit(
          g.run(repo, ["reset", "-q", "--", "a.txt"], {
            env: { GIT_TRACE2_EVENT: waiting },
          }),
        ),
      );
      while (exits(waiting) === 0) {
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      // Refused once; the other git lets go.
      rmSync(lock);
      while (resetting.pollUnsafe() === undefined) {
        yield* TestClock.adjust("50 millis");
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      return yield* Fiber.join(resetting);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.ok(Exit.isSuccess(outcome), "the reset ran once the lock was free");
  assert.equal(exits(waiting), 2);
  assert.equal(git(repo, "diff", "--cached", "--name-only").trim(), "");

  git(repo, "add", "a.txt");
  writeFileSync(lock, "");
  const held = join(tempDir("trace-"), "held");
  const failed = await withGit((g) =>
    Effect.gen(function* () {
      const resetting = yield* Effect.forkChild(
        Effect.exit(
          g.run(repo, ["reset", "-q", "--", "a.txt"], {
            env: { GIT_TRACE2_EVENT: held },
          }),
        ),
      );
      while (resetting.pollUnsafe() === undefined) {
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      return yield* Fiber.join(resetting);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  rmSync(lock);
  assert.ok(Exit.isFailure(failed), "a lock held for good still fails");
  assert.equal(exits(held), 6, "the first try and five more");
});

// A worktree with a change to stash (a.txt) and an untracked file (u.txt),
// whose refs/stash update takes index.lock as another program's `git
// status` would: after the stash is saved, before git's own reset.
function withStashRace() {
  const repo = seedRepo();
  write(repo, "a.txt", "changed\n");
  write(repo, "u.txt", "untracked\n");
  const lock = join(repo, ".git", "index.lock");
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q ' refs/stash$' || exit 0\ntouch '${lock}'\n`,
  );
  chmodSync(hook, 0o755);
  const stashes = () =>
    git(repo, "stash", "list", "--format=%gs").split("\n").filter(Boolean);
  return { repo, lock, stashes };
}

// Stashes `repo`, the test clock run on until it ends, with `onTick`
// between its steps.
const stashOnTheClock = (repo: string, onTick: () => void) =>
  withGit((g) =>
    Effect.gen(function* () {
      const stashing = yield* Effect.forkChild(
        Effect.exit(g.stashChanges(repo, "raced")),
      );
      while (stashing.pollUnsafe() === undefined) {
        onTick();
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      return yield* Fiber.join(stashing);
    }).pipe(Effect.provide(TestClock.layer())),
  );

it("a stash whose reset another git's lock refuses is saved once and finished, the worktree clean", async () => {
  const { repo, lock, stashes } = withStashRace();
  // The other git lets go 300 ms after it took the lock, long after
  // git's own reset was refused.
  const watching = setInterval(() => {
    if (!existsSync(lock)) return;
    clearInterval(watching);
    setTimeout(() => rmSync(lock), 300);
  }, 5);
  const outcome = await withGit((g) =>
    Effect.exit(g.stashChanges(repo, "raced")),
  ).finally(() => clearInterval(watching));
  assert.ok(Exit.isSuccess(outcome), "the stash finished");
  assert.deepEqual(stashes(), ["On main: raced"]);
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
  assert.equal(
    git(repo, "show", "stash@{0}^3:u.txt"),
    "untracked\n",
    "the untracked file is in the stash",
  );
});

it("a stash whose reset stays refused is saved once and says so, the changes still here", async () => {
  const { repo, lock, stashes } = withStashRace();
  const outcome = await stashOnTheClock(repo, () => {});
  rmSync(lock);
  assert.ok(Exit.isFailure(outcome));
  const error = Option.getOrThrow(Exit.findErrorOption(outcome));
  assert.ok(error instanceof GitRefusedError);
  assert.match(
    error.reason,
    /^It was saved to the stash list, with its new files, but another program's git/,
  );
  assert.deepEqual(stashes(), ["On main: raced"], "never saved twice");
  assert.match(git(repo, "status", "--porcelain"), /a\.txt/);
});

it("a stash refused before it saves is asked again, and saved once", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "changed\n");
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  const outcome = await withGit((g) =>
    Effect.gen(function* () {
      const stashing = yield* Effect.forkChild(
        Effect.exit(g.stashChanges(repo, "raced")),
      );
      // The clock stands still while the first push is refused (well
      // inside half a second); then the other git lets go.
      yield* Effect.promise(() => new Promise((done) => setTimeout(done, 500)));
      assert.equal(stashing.pollUnsafe(), undefined, "waiting to ask again");
      rmSync(lock);
      while (stashing.pollUnsafe() === undefined) {
        yield* TestClock.adjust("50 millis");
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      return yield* Fiber.join(stashing);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.ok(Exit.isSuccess(outcome));
  assert.equal(
    git(repo, "stash", "list", "--format=%gs").trim(),
    "On main: raced",
  );
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
});

it("a stash whose worktree changes before its reset is finished is left alone, and says so", async () => {
  const { repo, lock, stashes } = withStashRace();
  // A write between the save and the reset, which the stash doesn't hold.
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q ' refs/stash$' || exit 0\ntouch '${lock}'\necho later > '${join(repo, "b.txt")}'\n`,
  );
  // Held throughout: the check comes before any ask of the reset.
  const outcome = await stashOnTheClock(repo, () => {});
  rmSync(lock);
  assert.ok(Exit.isFailure(outcome));
  const error = Option.getOrThrow(Exit.findErrorOption(outcome));
  assert.ok(error instanceof GitRefusedError);
  assert.match(
    error.reason,
    /The worktree changed before the stash could clear it, so nothing was discarded/,
  );
  assert.deepEqual(stashes(), ["On main: raced"], "never saved twice");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "later\n");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "changed\n");
});

it("a person's commits in a terminal are never refused by the app's reads beside them", async () => {
  const repo = seedRepo();
  // git's own automatic maintenance, racing a hundred quick commits, can
  // repack away the commit HEAD names (2 of 15 runs with no app at all,
  // git 2.54): off, as in every fixture of the CLI's.
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "maintenance.auto", "false");
  // Enough files that a status's refresh writes back an index worth the
  // name, as on a real project.
  for (let file = 0; file < 2000; file += 1) {
    write(repo, `many/${file}.txt`, `${file}\n`);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "many");
  const refused: string[] = [];
  await withGit((g) =>
    Effect.gen(function* () {
      let finished = false;
      // The app reading, as fast as it can: a listing's status, a page's
      // changes and an open diff.
      const reading = yield* Effect.forkChild(
        Effect.forEach(
          [
            g.status(repo),
            g.changes(repo),
            g.fileDiff({ worktree: repo, paths: ["a.txt"], untracked: false }),
          ],
          (read) =>
            Effect.whileLoop({
              while: () => !finished,
              body: () => Effect.ignore(read),
              step: () => {},
            }),
          { concurrency: "unbounded", discard: true },
        ),
      );
      // The person: an edit, an add and a commit, two hundred times, with
      // a file saved unchanged each round, so every read finds the index's
      // stat cache stale and has something to write back.
      for (let round = 0; round < 200; round += 1) {
        write(repo, "a.txt", `round ${round}\n`);
        write(repo, `many/${round}.txt`, `${round}\n`);
        for (const args of [
          ["add", "a.txt"],
          [
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-q",
            "-m",
            `round ${round}`,
          ],
        ]) {
          try {
            git(repo, ...args);
          } catch (error) {
            refused.push(
              `${args.join(" ")}: ${String((error as { stderr?: unknown }).stderr ?? error)}`,
            );
          }
        }
        yield* Effect.promise(() => new Promise((done) => setTimeout(done, 5)));
      }
      finished = true;
      yield* Fiber.join(reading);
    }),
  );
  assert.deepEqual(
    refused,
    [],
    `${refused.length} of 400 writes refused, the first: ${refused[0] ?? ""}`,
  );
});

it("a write held by the user's hook leaves the probes their slots", async () => {
  const repo = seedRepo();
  const head = rev(repo, "HEAD");
  // Every ref update leaves a mark and waits in its
  // reference-transaction hook until the release file appears.
  const marks = tempDir("held-");
  const release = join(tempDir("release-"), "go");
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh\ncat >/dev/null\ntouch '${marks}'/$$\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\n`,
  );
  chmodSync(hook, 0o755);
  await withGit((g) =>
    Effect.gen(function* () {
      const writes = yield* Effect.forkChild(
        Effect.forEach(
          Array.from({ length: SPAWN_SLOTS + 1 }, (_, n) => n),
          (n) =>
            g.updateRef({ repo, ref: `refs/heads/held-${n}`, commit: head }),
          { concurrency: "unbounded", discard: true },
        ),
      );
      // As many writes as there are slots are waiting on the hook, and
      // a probe still answers. Released whatever happens, so no hook
      // outlives the test.
      yield* Effect.gen(function* () {
        while (readdirSync(marks).length < SPAWN_SLOTS) {
          yield* Effect.sleep("20 millis");
        }
        assert.equal(yield* g.verifyRev(repo, "HEAD"), head);
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.ensuring(Effect.sync(() => writeFileSync(release, ""))),
      );
      yield* Fiber.join(writes);
    }),
  );
  assert.equal(rev(repo, `refs/heads/held-${SPAWN_SLOTS}`), head);
});

it("a lenient read answers with what git printed whatever its exit, empty for a git that never ran, and still fails past the cap", async () => {
  const repo = seedRepo();
  // A diff --no-index of two different files exits 1 with the diff
  // printed.
  write(repo, "x.txt", "x\n");
  write(repo, "y.txt", "y\n");
  const diff = await withGit((g) =>
    g.runLenient(repo, ["diff", "--no-index", "--", "x.txt", "y.txt"]),
  );
  assert.match(diff, /^-x$/m);
  assert.match(diff, /^\+y$/m);
  assert.equal(
    await withGit((g) =>
      g.runLenient(repo, ["status"], { env: { PATH: "/nonexistent" } }),
    ),
    "",
  );
  await failureAs(GitOutputTooLargeError, (g) =>
    g.runLenient(repo, ["log"], { maxOutputBytes: 10 }),
  );
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
  // Interrupted once the hook is running, however long git takes to
  // get there.
  const outcome = await withGit((g) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        g.run(repo, ["commit", "-q", "--allow-empty", "-m", "slow"]),
      );
      while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "") {
        yield* Effect.sleep("20 millis");
      }
      yield* Fiber.interrupt(fiber);
      return yield* Effect.exit(Fiber.join(fiber));
    }),
  );
  assert.ok(Exit.hasInterrupts(outcome));
  const hook = Number(readFileSync(pidFile, "utf8"));
  // Killed is not yet reaped: a zombie still answers a signal 0 until
  // whoever adopts it collects it.
  await vi.waitFor(() => assert.throws(() => process.kill(hook, 0), /ESRCH/), {
    timeout: 5000,
    interval: 20,
  });
});

it("a commit and a push end at git's exit while a hook's child holds its stderr", async () => {
  // A project as a user has one, pushing to a scratch remote that holds
  // its history (a shallow checkout's clone can't push to an empty one).
  const repo = realClone();
  const remote = join(tempDir("remote-"), "remote.git");
  git(repo, "clone", "-q", "--bare", repo, remote);
  git(repo, "remote", "set-url", "origin", remote);
  const pids = join(tempDir("hook-"), "pids");
  // git hands a hook its stderr for stdout too; the child keeps both.
  for (const hook of ["pre-commit", "pre-push"]) {
    write(
      repo,
      `.git/hooks/${hook}`,
      `#!/bin/sh\n(echo started; sleep 30) &\necho $! >> '${pids}'\n`,
    );
    chmodSync(join(repo, `.git/hooks/${hook}`), 0o755);
  }
  await withGit((g) =>
    Effect.gen(function* () {
      yield* g.run(repo, ["commit", "-q", "--allow-empty", "-m", "hooked"]);
      yield* g.run(repo, ["push", "-q", "origin", "HEAD:refs/heads/hooked"]);
    }).pipe(Effect.timeout("10 seconds")),
  );
  assert.equal(rev(remote, "hooked"), rev(repo, "HEAD"));
  // What the hooks left goes with git's process group as the run ends.
  for (const pid of readFileSync(pids, "utf8").trim().split("\n")) {
    await vi.waitFor(
      () => assert.throws(() => process.kill(Number(pid), 0), /ESRCH/),
      { timeout: 5000, interval: 20 },
    );
  }
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

it("a merge's counts are what it brought in, against its first parent", async () => {
  const repo = seedRepo();
  git(repo, "checkout", "-q", "-b", "side");
  write(repo, "side.txt", "one\ntwo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "side");
  git(repo, "checkout", "-q", "main");
  write(repo, "b.txt", "bee\nbuzz\n");
  git(repo, "commit", "-q", "-am", "main");
  git(repo, "merge", "-q", "--no-edit", "side");
  const [merge] = await withGit((g) =>
    g.listCommits(repo, { skip: 0, count: 1 }),
  );
  assert.deepEqual(
    { additions: merge?.additions, deletions: merge?.deletions },
    { additions: 2, deletions: 0 },
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

it("resolves a name to its commit or says there is none, and refuses a HEAD that moved", async () => {
  const repo = seedRepo();
  const head = rev(repo, "HEAD");
  assert.equal(await withGit((g) => g.resolveCommit(repo, "main")), head);
  const unknown = await failureAs(UnknownRevisionError, (g) =>
    g.resolveCommit(repo, "nope"),
  );
  assert.equal(unknown.message, "There is no branch or commit named nope.");
  assert.equal(await withGit((g) => g.headAt(repo, undefined)), head);
  assert.equal(await withGit((g) => g.headAt(repo, head)), head);
  write(repo, "n.txt", "n\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "n");
  const moved = await failureAs(BranchMovedError, (g) => g.headAt(repo, head));
  assert.equal(
    moved.message,
    "The branch has moved on since this was loaded. Reload and try again.",
  );
});

it("names the upstream and counts HEAD's own commits past a ref", async () => {
  const { clone } = withRemote();
  assert.deepEqual(
    await withGit((g) => g.upstreamName(clone)),
    Option.some("origin/main"),
  );
  git(clone, "checkout", "-q", "-b", "loose");
  assert.deepEqual(await withGit((g) => g.upstreamName(clone)), Option.none());
  write(clone, "a.txt", "a\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "a");
  git(clone, "checkout", "-q", "-b", "side", "HEAD~1");
  write(clone, "b.txt", "b\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "b");
  git(clone, "checkout", "-q", "loose");
  git(clone, "merge", "-q", "--no-edit", "side");
  git(clone, "push", "-q", "origin", "side");
  assert.deepEqual(
    await withGit((g) => g.ownCommitCounts(clone, "origin/main")),
    { own: 3, merges: 1, unpushed: 2 },
  );
  assert.equal(
    await withGit((g) =>
      g.countCommits(clone, ["origin/main..HEAD"], ["--merges"]),
    ),
    1,
  );
});

it("lists branches by git's short names, a tag's namesake qualified and no symbolic ref", async () => {
  const { clone } = withRemote();
  git(clone, "tag", "main");
  git(clone, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
  assert.deepEqual(await withGit((g) => g.listBranches(clone)), {
    local: ["heads/main"],
    remote: ["origin/main"],
  });
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

it("creates a branch tracking the remote branch of its own name, and otherwise unpublished", async () => {
  const { clone } = withRemote();
  git(clone, "push", "-q", "origin", "main:feat");
  git(clone, "fetch", "-q", "origin");
  git(clone, "branch", "feature/base");
  await withGit((g) =>
    g.createBranch({ repo: clone, name: "feat", base: "origin/feat" }),
  );
  await withGit((g) =>
    g.createBranch({ repo: clone, name: "from-remote", base: "origin/main" }),
  );
  await withGit((g) =>
    g.createBranch({ repo: clone, name: "from-local", base: "feature/base" }),
  );
  assert.equal(
    git(clone, "config", "branch.feat.merge").trim(),
    "refs/heads/feat",
  );
  assert.throws(() => git(clone, "config", "branch.from-remote.merge"));
  assert.throws(() => git(clone, "config", "branch.from-local.merge"));
});

it("lists a remote's URL as this machine reaches it, and as configured for another machine", async () => {
  const { remote, clone } = withRemote();
  const configured = "https://github.com/example/proj.git";
  git(clone, "remote", "set-url", "origin", configured);
  git(clone, "config", `url.${remote}.insteadOf`, configured);
  assert.deepEqual(await withGit((g) => g.listRemoteEntries(clone)), [
    { name: "origin", url: remote },
  ]);
  assert.deepEqual(await withGit((g) => g.listConfiguredRemoteEntries(clone)), [
    { name: "origin", url: configured },
  ]);
});

it("adds a worktree on a new branch off a remote branch unpublished, whatever git's default", async () => {
  const { clone } = withRemote();
  git(clone, "config", "branch.autoSetupMerge", "always");
  const path = join(tempDir("wt-"), "fresh");
  await withGit((g) =>
    g.addWorktree({ repo: clone, path, branch: "fresh", base: "origin/main" }),
  );
  assert.throws(() => git(clone, "config", "branch.fresh.merge"));
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
  const dirty = await failureAs(GitRefusedError, (g) =>
    g.overwriteFromUpstream(clone),
  );
  assert.equal(
    dirty.message,
    "This worktree has uncommitted or untracked changes. Commit, stash, or discard them before overwriting from upstream.",
  );
  git(clone, "checkout", "-q", "--", "a.txt");

  write(clone, "secret.env", "mine\n");
  const ignored = await failureOf((g) => g.overwriteFromUpstream(clone));
  assert.equal(
    ignored.message,
    "This would replace ignored local file(s) that refs/remotes/origin/main tracks: secret.env. Move them aside first.",
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

it("every fetch whose remote stops answering ends at its deadline, the project's and a sync's", async () => {
  for (const fetch of [
    (g: Git.Git["Service"], repo: string) => g.fetchAll(repo),
    (g: Git.Git["Service"], repo: string) => g.pullRebaseOrMergeAndPush(repo),
  ]) {
    const repo = seedRepo();
    // A remote that is reached and then says nothing, as a connection
    // left half open does.
    const reached = join(repo, ".git", "remote-reached");
    git(repo, "config", "protocol.ext.allow", "always");
    git(
      repo,
      "remote",
      "add",
      "origin",
      `ext::sh -c touch% ${reached};% exec% sleep% 600`,
    );
    const exit = await withGit((g) =>
      Effect.gen(function* () {
        const fetching = yield* Effect.forkChild(fetch(g, repo));
        while (!existsSync(reached)) {
          yield* Effect.promise(
            () => new Promise((done) => setTimeout(done, 20)),
          );
        }
        yield* TestClock.adjust("5 minutes");
        return yield* Fiber.await(fetching);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    assert.ok(Exit.isFailure(exit), "the fetch still waits");
  }
});

// A branch two commits ahead of a main that moved on, whose rebase onto
// main another program's git stops after its first pick: it takes
// index.lock as the pick lands, once.
function withStoppedRebase() {
  const repo = seedRepo();
  git(repo, "checkout", "-q", "-b", "feat");
  write(repo, "f1.txt", "one\n");
  git(repo, "add", "f1.txt");
  git(repo, "commit", "-q", "-m", "f1");
  write(repo, "f2.txt", "two\n");
  git(repo, "add", "f2.txt");
  git(repo, "commit", "-q", "-m", "f2");
  git(repo, "checkout", "-q", "main");
  write(repo, "m.txt", "main\n");
  git(repo, "add", "m.txt");
  git(repo, "commit", "-q", "-m", "main moves on");
  git(repo, "checkout", "-q", "feat");
  const feat = rev(repo, "feat");
  const lock = join(repo, ".git", "index.lock");
  const stoppedOnce = join(tempDir("stopped-"), "once");
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\nin=$(cat)\n[ -s '${join(repo, ".git", "rebase-merge", "done")}' ] || exit 0\necho "$in" | grep -q ' HEAD$' || exit 0\n[ -e '${stoppedOnce}' ] && exit 0\ntouch '${stoppedOnce}' '${lock}'\n`,
  );
  chmodSync(hook, 0o755);
  const rebasing = () => existsSync(join(repo, ".git", "rebase-merge"));
  return { repo, feat, lock, stoppedOnce, rebasing };
}

it("a sync whose rebase is stopped and can't be undone stops there, and runs no merge on that HEAD", async () => {
  const { repo, lock, stoppedOnce, rebasing } = withStoppedRebase();
  const outcome = await withGit((g) =>
    Effect.gen(function* () {
      const syncing = yield* Effect.forkChild(
        Effect.exit(
          g.syncWithPrimary({ worktree: repo, repo, primaryRef: "main" }),
        ),
      );
      while (syncing.pollUnsafe() === undefined) {
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      return yield* Fiber.join(syncing);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  rmSync(lock);
  assert.ok(existsSync(stoppedOnce), "the rebase was stopped part-way");
  assert.ok(Exit.isFailure(outcome));
  const error = Option.getOrThrow(Exit.findErrorOption(outcome));
  assert.ok(error instanceof GitRefusedError, String(error));
  assert.match(
    error.reason,
    /^The rebase stopped part-way and couldn't be undone/,
  );
  assert.ok(rebasing(), "left in git's own rebase, for the banner");
  assert.ok(!existsSync(join(repo, ".git", "MERGE_HEAD")), "no merge ran");
});

it("a sync whose stopped rebase is undone once the lock goes merges instead", async () => {
  const { repo, feat, lock, rebasing } = withStoppedRebase();
  // The rebase's own exit, as git traces it, so the other git lets go
  // only once the rebase has stopped: never before its second pick,
  // however slow the machine.
  const trace = join(tempDir("trace-"), "events");
  const rebaseExited = () => {
    if (!existsSync(trace)) return false;
    const events = readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { event: string; sid: string; argv?: string[] },
      );
    const rebases = new Set(
      events
        .filter(
          (each) =>
            each.event === "start" &&
            each.argv?.includes("rebase") === true &&
            each.argv.includes("--end-of-options"),
        )
        .map((each) => each.sid),
    );
    return events.some(
      (each) => each.event === "exit" && rebases.has(each.sid),
    );
  };
  process.env["GIT_TRACE2_EVENT"] = trace;
  const outcome = await withGit((g) =>
    Effect.gen(function* () {
      const syncing = yield* Effect.forkChild(
        Effect.exit(
          g.syncWithPrimary({ worktree: repo, repo, primaryRef: "main" }),
        ),
      );
      // The clock stands still: the refused abort's retry waits on it.
      while (!rebaseExited()) {
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      rmSync(lock);
      while (syncing.pollUnsafe() === undefined) {
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      return yield* Fiber.join(syncing);
    }).pipe(Effect.provide(TestClock.layer())),
  ).finally(() => {
    delete process.env["GIT_TRACE2_EVENT"];
  });
  assert.ok(Exit.isSuccess(outcome), "the sync finished");
  assert.ok(!rebasing());
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "feat");
  // A merge of the branch as it was, not of a half-rebased HEAD.
  assert.deepEqual(
    git(repo, "rev-list", "--parents", "-n", "1", "HEAD")
      .trim()
      .split(" ")
      .slice(1),
    [feat, rev(repo, "main")],
  );
});

it("a sync refuses a merge already under way, and leaves it", async () => {
  const repo = seedRepo();
  git(repo, "checkout", "-q", "-b", "feat");
  write(repo, "a.txt", "feat's\n");
  git(repo, "commit", "-q", "-am", "feat's");
  git(repo, "checkout", "-q", "main");
  write(repo, "a.txt", "main's\n");
  git(repo, "commit", "-q", "-am", "main's");
  git(repo, "checkout", "-q", "feat");
  // The person's own merge, stopped on its conflict.
  assert.throws(() => git(repo, "merge", "-q", "--no-edit", "main"));
  write(repo, "a.txt", "resolved\n");
  const error = await failureAs(GitRefusedError, (g) =>
    g.syncWithPrimary({ worktree: repo, repo, primaryRef: "main" }),
  );
  assert.equal(error.reason, "Finish or abort the merge first.");
  assert.ok(existsSync(join(repo, ".git", "MERGE_HEAD")));
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "resolved\n");
});

it("a cherry-pick that conflicts and can't be undone says so, not that nothing changed", async () => {
  const repo = seedRepo();
  git(repo, "checkout", "-q", "-b", "other");
  write(repo, "a.txt", "theirs\n");
  git(repo, "commit", "-q", "-am", "theirs");
  const pick = rev(repo, "other");
  git(repo, "checkout", "-q", "main");
  write(repo, "a.txt", "ours\n");
  git(repo, "commit", "-q", "-am", "ours");
  // Another program's git takes index.lock as the pick stops.
  const lock = join(repo, ".git", "index.lock");
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q ' CHERRY_PICK_HEAD$' || exit 0\ntouch '${lock}'\n`,
  );
  chmodSync(hook, 0o755);
  const outcome = await withGit((g) =>
    Effect.gen(function* () {
      const picking = yield* Effect.forkChild(
        Effect.exit(g.cherryPickCommit(repo, pick)),
      );
      while (picking.pollUnsafe() === undefined) {
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      return yield* Fiber.join(picking);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  const held = existsSync(lock);
  if (held) rmSync(lock);
  assert.ok(held, "the lock was taken as the pick stopped");
  assert.ok(Exit.isFailure(outcome));
  const error = Option.getOrThrow(Exit.findErrorOption(outcome));
  assert.ok(error instanceof GitRefusedError, String(error));
  assert.match(
    error.reason,
    /^The cherry-pick stopped part-way and couldn't be undone/,
  );
  assert.ok(existsSync(join(repo, ".git", "CHERRY_PICK_HEAD")));
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
      g.clone({
        url: remote,
        parentDir: parent,
        name: "c",
        config: [
          ["credential.https://example.test.helper", ""],
          ["credential.https://example.test.helper", "!true"],
        ],
      }),
    ),
    join(parent, "c"),
  );
  // The config lands in the clone's own, every value in order.
  assert.deepEqual(
    git(
      join(parent, "c"),
      "config",
      "--local",
      "--get-all",
      "credential.https://example.test.helper",
    ).split("\n"),
    ["", "!true", ""],
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

it("an interrupted clone leaves no folder behind", async () => {
  const parent = tempDir("clone-into-");
  const dest = join(parent, "c");
  // A remote that takes the connection and never answers, so the clone
  // is under way, its folder made, when it is interrupted.
  const server = createServer((socket) => socket.unref());
  const connected = once(server, "connection");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const outcome = await withGit((g) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          g.clone({
            url: `http://127.0.0.1:${port}/owner/repo.git`,
            parentDir: parent,
            name: "c",
          }),
        );
        yield* Effect.promise(() => connected);
        assert.ok(existsSync(dest));
        yield* Fiber.interrupt(fiber);
        return yield* Effect.exit(Fiber.join(fiber));
      }),
    );
    assert.ok(Exit.hasInterrupts(outcome));
    assert.ok(!existsSync(dest));
  } finally {
    server.close();
  }
});

it("an interrupted create leaves no folder behind", async () => {
  const parent = tempDir("create-into-");
  const dest = join(parent, "c");
  // A hook from the global config (`--no-verify` doesn't skip this
  // one) holds the first commit's ref update, so the folder is made and
  // the commit under way when the create is interrupted.
  const hooks = tempDir("hooks-");
  const held = join(tempDir("held-"), "held");
  const release = join(tempDir("release-"), "go");
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\ngrep -q refs/heads/ || exit 0\ntouch '${held}'\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\n`,
  );
  chmodSync(join(hooks, "reference-transaction"), 0o755);
  const config = join(hooks, "config");
  writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  try {
    const outcome = await withGit((g) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(g.createRepository(parent, "c"));
        while (!existsSync(held)) {
          yield* Effect.sleep("20 millis");
        }
        yield* Fiber.interrupt(fiber);
        return yield* Effect.exit(Fiber.join(fiber));
      }),
    );
    assert.ok(Exit.hasInterrupts(outcome));
    assert.ok(!existsSync(dest));
  } finally {
    vi.unstubAllEnvs();
    writeFileSync(release, "");
  }
});

it("a new repository lands on main with one empty commit, and never over a folder", async () => {
  const parent = tempDir("create-into-");
  const dest = await withGit((g) => g.createRepository(parent, "fresh"));
  assert.equal(dest, join(parent, "fresh"));
  assert.equal(git(dest, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
  assert.equal(git(dest, "rev-list", "--count", "HEAD").trim(), "1");
  const taken = await failureAs(CloneDestinationError, (g) =>
    g.createRepository(parent, "fresh"),
  );
  assert.equal(taken.reason, "exists");
  const missing = await failureAs(CloneDestinationError, (g) =>
    g.checkDestination(join(parent, "nope"), "x"),
  );
  assert.equal(missing.reason, "not-a-folder");
  symlinkSync(join(parent, "gone"), join(parent, "dangling"));
  const dangling = await failureAs(CloneDestinationError, (g) =>
    g.createRepository(parent, "dangling"),
  );
  assert.equal(dangling.reason, "exists");
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
