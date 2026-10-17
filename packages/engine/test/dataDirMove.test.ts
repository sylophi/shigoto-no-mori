// The data-folder move's recovery as every engine process runs it, and
// the lock that makes a move the one change under way (V3.md, Commit
// points): while a move's journal is in the data dir the store refuses
// every process's writes, and the next engine graph to come up, the
// terminal's as much as the app's, settles it first, holding the lock
// alone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, beforeEach, it } from "vitest";
import * as DataDirLock from "../src/DataDirLock.ts";
import { finishMove, resumeDataDirMove } from "../src/dataDirMove.ts";
import { JOURNAL, retired, retireStore } from "../src/dataDirMoveJournal.ts";
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

// A change holds the lock shared, a move alone: a change is refused
// while a move holds it, and a move waits out a change, then refuses.
it("refuses a change while a move holds the lock, and a move while a change runs past its wait", async () => {
  const result = (await box.engine(
    Effect.gen(function* () {
      const lock = yield* DataDirLock.DataDirLock;
      const refused = yield* lock
        .alone(Effect.exit(lock.guard(Effect.void)), "1 second")
        .pipe(Effect.map((exit) => Exit.isFailure(exit)));
      const release = yield* Deferred.make<void>();
      const holding = yield* Deferred.make<void>();
      const change = yield* lock
        .guard(
          Deferred.succeed(holding, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holding);
      const waited = yield* Effect.exit(lock.alone(Effect.void, "300 millis"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(change);
      const after = yield* Effect.exit(lock.alone(Effect.void, "1 second"));
      return {
        refused,
        waited: Exit.isFailure(waited),
        after: Exit.isSuccess(after),
      };
    }),
  )) as { refused: boolean; waited: boolean; after: boolean };
  assert.deepEqual(result, { refused: true, waited: true, after: true });
});

// The lock is the kernel's: a process killed while it holds it holds
// it no more, with no pid read to tell.
it("lets a move take the lock a killed process held", async () => {
  const lockFile = (await box.engine(
    Effect.map(Paths.Paths, ({ pointerFile }) =>
      join(pointerFile, "..", "data-dir.lock"),
    ),
  )) as string;
  mkdirSync(join(lockFile, ".."), { recursive: true });
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(${JSON.stringify(lockFile)});
       db.exec("PRAGMA locking_mode = EXCLUSIVE");
       db.prepare("SELECT count(*) FROM sqlite_schema").get();
       console.log("held");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise<void>((resolve) =>
      holder.stdout.once("data", () => resolve()),
    );
    const refused = (await box.engine(
      Effect.flatMap(DataDirLock.DataDirLock, (lock) =>
        Effect.exit(lock.alone(Effect.void, "300 millis")),
      ),
    )) as Exit.Exit<void, unknown>;
    assert.ok(Exit.isFailure(refused));
    holder.kill("SIGKILL");
    const taken = (await box.engine(
      Effect.flatMap(DataDirLock.DataDirLock, (lock) =>
        Effect.exit(lock.alone(Effect.void, "5 seconds")),
      ),
    )) as Exit.Exit<void, unknown>;
    assert.ok(Exit.isSuccess(taken));
  } finally {
    holder.kill("SIGKILL");
  }
});

// A process that found the data dir before a move took it elsewhere
// makes no change there.
it("refuses a change in a process whose data dir moved since it started", async () => {
  const home = mkdtempSync(join(tmpdir(), "engine-lock-"));
  try {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const { pointerFile } = yield* Paths.Paths;
        mkdirSync(join(pointerFile, ".."), { recursive: true });
        writeFileSync(pointerFile, `${join(home, "moved")}\n`);
        const lock = yield* DataDirLock.DataDirLock;
        return yield* Effect.exit(lock.guard(Effect.void));
      }).pipe(
        Effect.provide(
          DataDirLock.layer(openNode).pipe(
            Layer.provideMerge(Paths.layer("prod")),
            Layer.provide(NodeServices.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { HOME: home } }),
              ),
            ),
          ),
        ),
      ),
    );
    assert.ok(
      Option.getOrUndefined(Exit.findErrorOption(exit)) instanceof
        DataDirLock.DataDirMoved,
    );
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
