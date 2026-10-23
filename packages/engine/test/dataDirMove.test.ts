// The data-folder move's recovery as every engine process runs it:
// while a move's journal is in the data dir the store refuses every
// process's writes, and the next engine graph to come up, the
// terminal's as much as the app's, settles it first, holding the lock
// alone.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, beforeEach, it } from "vitest";
import * as DataDirLock from "../src/DataDirLock.ts";
import { finishMove, resumeDataDirMove } from "../src/dataDirMove.ts";
import { JOURNAL, retired, retireStore } from "../src/dataDirMoveJournal.ts";
import { flavorNames } from "../src/flavor.ts";
import * as Paths from "../src/Paths.ts";
import * as Registry from "../src/Registry.ts";
import * as WorktreeData from "../src/WorktreeData.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { openNode } from "./lib/nodeStore.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;

// The settle as a graph runs it coming up: the lock alone, on the
// sandbox's platform.
const settleAt = (dir: string) =>
  box.engine(
    Effect.flatMap(DataDirLock.DataDirLock, (lock) =>
      lock.alone(resumeDataDirMove(dir), "5 seconds"),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
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

// The lock and the Paths of a process whose home is `home`, with no
// data dir override.
const lockAtHome = (home: string) =>
  DataDirLock.layer(openNode).pipe(
    Layer.provideMerge(Paths.layer("dev")),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
    ),
  );

// A rename a crash cut before its pointer moved: the folder this
// process found is gone, and the journal at the new place names it. The
// change is refused, and the pointer committed for the next start.
it("refuses a change after a rename a crash cut before its pointer moved", async () => {
  const home = mkdtempSync(join(tmpdir(), "engine-lock-"));
  // The data dir this process found as it started.
  mkdirSync(join(home, flavorNames("dev").dataDir));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { pointerFile, dataDir } = yield* Paths.Paths;
        const moved = join(home, "ext", basename(dataDir));
        mkdirSync(join(home, "ext"));
        mkdirSync(dirname(pointerFile), { recursive: true });
        writeFileSync(`${pointerFile}.tmp.x`, `${moved}\n`);
        writeFileSync(
          join(dataDir, JOURNAL),
          JSON.stringify({
            from: dataDir,
            to: moved,
            partial: null,
            moved: [],
          }),
        );
        renameSync(dataDir, moved);
        const lock = yield* DataDirLock.DataDirLock;
        const exit = yield* Effect.exit(lock.guard(Effect.void));
        return {
          refused:
            Option.getOrUndefined(Exit.findErrorOption(exit)) instanceof
            DataDirLock.DataDirMoved,
          pointer: readFileSync(pointerFile, "utf8").trim(),
          moved,
          recreated: existsSync(dataDir),
        };
      }).pipe(Effect.provide(lockAtHome(home))),
    );
    assert.deepEqual(result, {
      refused: true,
      pointer: result.moved,
      moved: result.moved,
      recreated: false,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A store left refusing with no journal (a move that died between its
// refusal and its journal, or between its journal going and its store
// writing again) writes again at the next settle.
it("lets a store a move left refusing with no journal write again", async () => {
  const dataDir = box.side("engine");
  await box.engine(retireStore);
  await settleAt(dataDir);
  assert.equal(await box.engine(retired), false);
});

// A process whose data dir a move has taken elsewhere leaves the move's
// journal for the process the pointer leads to.
it("leaves a move's journal at a folder the data dir has left", async () => {
  await box.engine(Effect.void);
  const old = join(box.home, "old-data");
  mkdirSync(old);
  writeFileSync(
    join(old, JOURNAL),
    JSON.stringify({
      from: old,
      to: join(box.home, "elsewhere"),
      partial: null,
      moved: [],
    }),
  );
  await settleAt(old);
  assert.ok(existsSync(join(old, JOURNAL)));
});

// A registered project whose folder is gone has nothing to repair, and
// keeps no finish from ending.
it("finishes a move past a registered project whose folder is gone", async () => {
  const dataDir = box.side("engine");
  const gone = box.repo("gone", { "README.md": "hi\n" });
  await box.engine(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({ name: "gone", path: gone }),
    ),
  );
  rmSync(gone, { recursive: true });
  writeFileSync(
    join(dataDir, JOURNAL),
    JSON.stringify({
      from: join(box.home, "moved-from"),
      to: dataDir,
      partial: null,
      moved: [],
    }),
  );
  await settleAt(dataDir);
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => name.startsWith("data-dir-move")),
    [],
  );
});

// A copy's old tree outlives the move that made it: the first process
// to open the store at the new place removes it, so a power loss before
// the copy reached the disk still has it.
it("keeps a copied move's old tree until the store is opened at the new place", async () => {
  const dataDir = box.side("engine");
  await box.engine(Effect.void);
  const old = join(box.home, "old-data");
  mkdirSync(old);
  const journal = {
    from: old,
    to: dataDir,
    partial: `${dataDir}.partial-x`,
    moved: [],
  };
  writeFileSync(join(old, JOURNAL), JSON.stringify(journal));
  writeFileSync(join(dataDir, JOURNAL), JSON.stringify(journal));
  await box.engine(
    finishMove(journal, dataDir, {
      settle: false,
      file: join(dataDir, JOURNAL),
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.ok(existsSync(old), "the old tree kept by the moving process");
  await settleAt(dataDir);
  assert.equal(existsSync(old), false, "removed at the new place's open");
});
