// A worktree's move through the running app answers the engine's own
// row, as one made here does (src/worktrees/throughApp.ts): the app's
// document is its own, without the project's name.
import assert from "node:assert/strict";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Worktrees from "../src/Worktrees.ts";
import { moveWorktree } from "../src/worktrees/throughApp.ts";
import { type FakeApp, fakeApp, success } from "./lib/fakeApp.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
let app: FakeApp | undefined;
beforeEach(() => {
  box = sandbox();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await box.remove();
});

it("a move the app made answers the engine's row of it, its project's name with it", async () => {
  const repo = box.repo("repo");
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
  });
  const fox = join(repo, ".shigomori", "wt", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", fox);
  const destination = join(box.home, "elsewhere", "fox");
  // Published before the engine first runs. It answers with the app's
  // own document of the move, which has no projectName.
  let appDocument: unknown = null;
  app = await fakeApp((request) =>
    request.channel === "worktrees:relocate"
      ? [success(request, appDocument)]
      : [],
  );
  box.write("loopback.json", app.file());
  const locate = Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const here = yield* worktrees.here(box.home);
    return {
      here,
      located: yield* worktrees.resolve(here, { project: "repo", ref: "fox" }),
    };
  });
  const before = (await box.engine(locate)) as Effect.Success<typeof locate>;
  // The move as the app makes it, and the row this engine reads of it.
  const move = Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
    worktrees.move(before.located, destination),
  );
  const made = (await box.engine(move)) as Effect.Success<typeof move>;
  assert.equal(made.worktree.projectName, "repo");
  const { projectName: _left, ...withoutName } = made.worktree;
  appDocument = withoutName;
  const answered = await box.engine(
    moveWorktree(before.here, before.located, destination),
  );
  assert.deepEqual(answered, {
    worktree: made.worktree,
    previousId: before.located.worktree.id,
  });
  assert.equal(app.received().at(-1)?.request.channel, "worktrees:relocate");
});
