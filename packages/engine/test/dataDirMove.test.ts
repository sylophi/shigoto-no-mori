// The data-folder move's recovery as every engine process runs it (V3.md,
// Commit points): while a move's journal is in the data dir the store
// refuses every process's writes, and the next engine graph to come up,
// the terminal's as much as the app's, settles it first.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, it } from "vitest";
import { JOURNAL, retireStore } from "../src/dataDirMoveJournal.ts";
import * as Registry from "../src/Registry.ts";
import * as WorktreeData from "../src/WorktreeData.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

it("refuses a terminal's write while a crashed move's journal is out, and the next start undoes the move", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const dataDir = box.side("engine");
  const newPath = join(box.home, "moved", "wt", "proj", "fox");
  const made = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      const project = yield* registry.register({ name: "proj", path: repo });
      const { worktree } = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      yield* data.describe(project.id, worktree.id, { title: "Fox" });
      // A move a crash cut after its re-key: the journal, the store
      // refusing, what the worktree keeps under its new id.
      yield* worktrees.rekey(project, worktree.id, newPath, { expect: null });
      writeFileSync(
        join(dataDir, JOURNAL),
        JSON.stringify({
          from: dataDir,
          to: join(box.home, "moved"),
          partial: null,
          pid: 4_194_304,
          startedAt: 0,
          moved: [
            {
              projectId: project.id,
              oldPath: worktree.path,
              newPath,
              capture: null,
              state: "rekeyed",
            },
          ],
        }),
      );
      yield* retireStore;
      return { projectId: project.id, worktreeId: worktree.id };
    }),
  )) as { projectId: string; worktreeId: string };

  // A terminal already running can't write over what the move owes.
  const refused = (await box.engine(
    Effect.flatMap(WorktreeData.WorktreeData, (data) =>
      data.describe(made.projectId, made.worktreeId, { title: "Edited" }),
    ).pipe(Effect.exit),
  )) as Exit.Exit<unknown, unknown>;
  assert.ok(Exit.isFailure(refused));

  // The next process to come up settles the move first.
  await box.start();
  assert.equal(existsSync(join(dataDir, JOURNAL)), false);
  const after = (await box.engine(
    Effect.gen(function* () {
      const data = yield* WorktreeData.WorktreeData;
      const back = yield* data.description(made.projectId, made.worktreeId);
      const written = yield* data.describe(made.projectId, made.worktreeId, {
        description: "writes again",
      });
      return { title: back.title, written: written.description };
    }),
  )) as { title: string; written: string };
  assert.deepEqual(after, { title: "Fox", written: "writes again" });
});
