import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

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
        { report: () => Effect.void, color: false },
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
        { report: () => Effect.void, color: false },
      );
      return box.git(repo, "branch", "--list", fox.branch).trim();
    }),
  );
  assert.notEqual(left, "", "a branch named like the detached head went");
});
