import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { afterEach, beforeEach, it, onTestFinished } from "vitest";
import * as Git from "../src/Git.ts";
import { HoldersOnDelete } from "../src/HoldersOnDelete.ts";
import { MirrorsOnDelete } from "../src/MirrorsOnDelete.ts";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const silent = { report: () => Effect.void, color: false };

// A detached worktree has no branch: its listing names it by its short
// hash, which a branch of that name must not be taken for.
it("deletes no branch when it removes a detached worktree", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const left = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        silent,
      );
      box.git(made.worktree.path, "checkout", "-q", "--detach");
      const fox = (yield* worktrees.identities(project)).find(
        (row) => row.id === made.worktree.id,
      );
      assert.ok(fox?.detached);
      box.git(repo, "branch", fox.branch);
      yield* worktrees.remove(
        { project, worktree: fox },
        { force: false, keepBranch: false, skipCleanup: true },
        silent,
      );
      return box.git(repo, "branch", "--list", fox.branch).trim();
    }),
  );
  assert.notEqual(left, "", "a branch named like the detached head went");
});

// The default branch can be out in a worktree (a bare repo's, or one
// whose primary checkout is on another branch), and nothing else holds
// it then.
it("keeps the project's default branch when it removes the worktree it is out in", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  box.git(repo, "checkout", "-q", "-b", "other");
  const removed = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const made = yield* worktrees.create(
        project,
        { name: "trunk", base: "main", checkout: true, skipSetup: true },
        silent,
      );
      const located = yield* worktrees.resolve(yield* worktrees.nowhere, {
        projectId: project.id,
        worktreeId: made.worktree.id,
      });
      assert.equal(located.worktree.branch, "main");
      return yield* worktrees.remove(
        located,
        { force: false, keepBranch: false, skipCleanup: true },
        silent,
      );
    }),
  );
  assert.equal((removed as Worktrees.Removed).branch, "main");
  assert.equal(box.git(repo, "branch", "--list", "main").trim(), "main");
});

// A bare clone's default branch is the one its HEAD names, which no
// remote's HEAD records there, here sorted after another branch.
it("keeps a bare clone's default branch when it removes the worktree it is out in", async () => {
  const upstream = box.repo("upstream", { "README.md": "hi\n" });
  box.git(upstream, "branch", "-m", "trunk");
  box.git(upstream, "branch", "alpha");
  const repo = join(box.home, "proj.git");
  box.git(box.home, "clone", "-q", "--bare", upstream, repo);
  const removed = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const made = yield* worktrees.create(
        project,
        { name: "trunk", base: "trunk", checkout: true, skipSetup: true },
        silent,
      );
      return yield* worktrees.remove(
        yield* worktrees.resolve(yield* worktrees.nowhere, {
          projectId: project.id,
          worktreeId: made.worktree.id,
        }),
        { force: false, keepBranch: false, skipCleanup: true },
        silent,
      );
    }),
  );
  assert.equal((removed as Worktrees.Removed).branch, "trunk");
  assert.equal(
    box.git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/trunk"),
    "refs/heads/trunk\n",
  );
});

// A worktree holding only an untracked file, in a repo whose git config
// hides untracked files from status.
const withLooseFile = async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  box.git(repo, "config", "status.showUntrackedFiles", "no");
  const located = (await box.engine(
    Effect.gen(function* () {
      const project = yield* (yield* Registry.Registry).register({
        name: "proj",
        path: repo,
      });
      const worktrees = yield* Worktrees.Worktrees;
      const { worktree } = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        silent,
      );
      return yield* worktrees.resolve(yield* worktrees.nowhere, {
        projectId: project.id,
        worktreeId: worktree.id,
      });
    }),
  )) as Worktrees.Located;
  const loose = join(located.worktree.path, "loose.txt");
  writeFileSync(loose, "x\n");
  return { repo, located, loose };
};

it("the dirty check counts an untracked file the user's git setting hides", async () => {
  const { located, loose } = await withLooseFile();
  const refused = (await box.engine(
    Effect.flatMap(Effect.service(Worktrees.Worktrees), (worktrees) =>
      worktrees.remove(
        located,
        { force: false, keepBranch: false, skipCleanup: true },
        silent,
      ),
    ),
  )) as Record<string, unknown>;
  assert.equal(refused["code"], "uncommitted-changes", JSON.stringify(refused));
  assert.ok(existsSync(loose));
});

it("git's own remove refuses an untracked file the user's git setting hides", async () => {
  const { repo, located, loose } = await withLooseFile();
  const refused = (await box.engine(
    Effect.flatMap(Effect.service(Git.Git), (git) =>
      git.removeWorktree({ repo, path: located.worktree.path, force: false }),
    ),
  )) as Record<string, unknown> | undefined;
  assert.equal(refused?.["ok"], false);
  assert.ok(existsSync(loose));
});

// The app's side of MirrorsOnDelete, noting whether the worktree's files
// were there when its mirror stopped, and how it was told the delete
// ended.
const removingMirrored = (
  located: Worktrees.Located,
  options: { readonly force: boolean },
) => {
  const told: string[] = [];
  const at = () => (existsSync(located.worktree.path) ? "there" : "gone");
  return box
    .engine(
      Effect.flatMap(Effect.service(Worktrees.Worktrees), (worktrees) =>
        worktrees.remove(
          located,
          { ...options, keepBranch: false, skipCleanup: true },
          silent,
        ),
      ).pipe(
        Effect.provideService(
          MirrorsOnDelete,
          MirrorsOnDelete.of({
            stop: () =>
              Effect.sync(() => {
                told.push(`stopped, files ${at()}`);
                return (end) =>
                  Effect.sync(() => {
                    told.push(`ended ${end}`);
                  });
              }),
          }),
        ),
      ),
    )
    .then(() => told);
};

// A mirror running while the files go one by one would carry each
// delete to the other device.
it("stops a worktree's mirror before its files go, and tells it they went", async () => {
  const { located } = await withLooseFile();
  assert.deepEqual(await removingMirrored(located, { force: true }), [
    "stopped, files there",
    "ended gone",
  ]);
  assert.ok(!existsSync(located.worktree.path));
});

it("a delete its checks refuse never stops the worktree's mirror", async () => {
  const { located, loose } = await withLooseFile();
  assert.deepEqual(await removingMirrored(located, { force: false }), []);
  assert.ok(existsSync(loose));
});

// A process working in the worktree, and the app's side of
// HoldersOnDelete, which ends it and notes whom it was asked for and
// whether the worktree's files were there then.
const removingHeld = async (
  located: Worktrees.Located,
  options: { readonly force: boolean },
) => {
  const held = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    cwd: located.worktree.path,
    stdio: "ignore",
  });
  onTestFinished(() => {
    held.kill();
  });
  const told: Array<{ owner: object; filesThere: boolean }> = [];
  const removed = await box.engine(
    Effect.flatMap(Effect.service(Worktrees.Worktrees), (worktrees) =>
      worktrees.remove(
        located,
        { ...options, keepBranch: false, skipCleanup: true },
        silent,
      ),
    ).pipe(
      Effect.provideService(
        HoldersOnDelete,
        HoldersOnDelete.of({
          release: (owner) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  told.push({
                    owner,
                    filesThere: existsSync(located.worktree.path),
                  });
                  held.once("exit", () => resolve());
                  held.kill();
                }),
            ),
        }),
      ),
    ),
  );
  return { removed, told };
};

// Windows deletes no folder a process works in.
it("lets go of what the app runs in a worktree right before its files go", async () => {
  const { located } = await withLooseFile();
  const { told } = await removingHeld(located, { force: true });
  assert.deepEqual(told, [
    {
      owner: { projectId: located.project.id, worktreeId: located.worktree.id },
      filesThere: true,
    },
  ]);
  assert.ok(!existsSync(located.worktree.path));
});

it("a delete its checks refuse keeps what the app runs in the worktree", async () => {
  const { located, loose } = await withLooseFile();
  const { removed, told } = await removingHeld(located, { force: false });
  assert.equal(
    (removed as Record<string, unknown>)["code"],
    "uncommitted-changes",
  );
  assert.deepEqual(told, []);
  assert.ok(existsSync(loose));
});

// Windows refuses to delete a read-only file unless asked to clear it.
it("removes a worktree holding read-only files", async () => {
  const { located, loose } = await withLooseFile();
  const nested = join(located.worktree.path, "built");
  mkdirSync(nested);
  writeFileSync(join(nested, "out.js"), "x\n");
  chmodSync(join(nested, "out.js"), 0o444);
  chmodSync(loose, 0o444);
  await box.engine(
    Effect.flatMap(Effect.service(Worktrees.Worktrees), (worktrees) =>
      worktrees.remove(
        located,
        { force: true, keepBranch: false, skipCleanup: true },
        silent,
      ),
    ),
  );
  assert.ok(!existsSync(located.worktree.path));
});

// An id from before a rename follows to the worktree it became, until
// that one is removed: a worktree made at its path later has its id,
// and must never be taken for the one the old id named.
it("a removed worktree's old ids don't follow to a new worktree at its path", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const byId = (worktreeId: string) =>
        Effect.flatMap(worktrees.nowhere, (at) =>
          worktrees.resolve(at, { projectId: project.id, worktreeId }),
        );
      const foo = yield* worktrees.create(
        project,
        { name: "foo", skipSetup: true },
        silent,
      );
      const renamed = yield* worktrees.rename(project, foo.worktree.id, "bar");
      const followed = (yield* byId(foo.worktree.id)).worktree.id;
      yield* worktrees.remove(
        yield* byId(renamed.worktree.id),
        { force: true, keepBranch: false, skipCleanup: true },
        silent,
      );
      const again = yield* worktrees.create(
        project,
        { name: "bar", branch: "bar-again", skipSetup: true },
        silent,
      );
      const stale = yield* Effect.result(byId(foo.worktree.id));
      return {
        followed: followed === renamed.worktree.id,
        sameId: again.worktree.id === renamed.worktree.id,
        gone:
          Result.isFailure(stale) &&
          Predicate.isTagged(stale.failure, "UnknownWorktreeError"),
      };
    }),
  )) as { followed: boolean; sameId: boolean; gone: boolean };
  assert.deepEqual(result, {
    followed: true,
    sameId: true,
    gone: true,
  });
});
