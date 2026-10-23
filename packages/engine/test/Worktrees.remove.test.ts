import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Git from "../src/Git.ts";
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
