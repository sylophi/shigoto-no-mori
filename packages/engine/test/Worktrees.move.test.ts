// `worktrees move` out of a v2 root into `wt`: the worktree stays
// managed, and what is kept under its id follows it (real git on a
// sandbox data dir).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

it("moves a worktree from a v2 root into wt, managed, its id carried over", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const dataDir = box.side("engine");
  const from = join(dataDir, "worktrees", "proj", "fox");
  const to = join(dataDir, "wt", "proj", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", from);
  const moved = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const found = yield* worktrees.identities(project);
      const fox = found.find(({ name }) => name === "fox");
      assert.ok(fox && !fox.isExternal);
      yield* worktrees.setAutoPull(fox, true);
      const result = yield* worktrees.move({ project, worktree: fox }, to);
      return {
        ...result,
        oldId: fox.id,
        autoPull: [...(yield* registry.marked("autoPull"))],
      };
    }),
  )) as {
    worktree: Worktrees.WorktreeRow;
    previousId: string;
    oldId: string;
    autoPull: string[];
  };
  assert.equal(moved.worktree.path, to);
  assert.ok(!moved.worktree.isExternal);
  assert.equal(moved.previousId, moved.oldId);
  assert.notEqual(moved.worktree.id, moved.oldId);
  assert.deepEqual(moved.autoPull, [moved.worktree.id]);
  assert.ok(!existsSync(join(dataDir, "worktrees", "proj")));
});
