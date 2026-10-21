// The data-folder move's recovery as every engine process runs it, and
// the lock that makes a move the one change under way: while a move's
// journal is in the data dir the store refuses every process's writes,
// and the next engine graph to come up, the terminal's as much as the
// app's, settles it first, holding the lock alone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
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

// A move waits for a change of its own process's without stopping the
// process (SQLite's own wait would), and a change nested in one already
// holding the lock goes on while the move waits, rather than be left
// half done.
it("waits out a change of its own process, and lets a change nested in one finish", async () => {
  const result = (await box.engine(
    Effect.gen(function* () {
      const lock = yield* DataDirLock.DataDirLock;
      const inside = yield* Deferred.make<void>();
      const nested = yield* Deferred.make<boolean>();
      const change = yield* lock
        .guard(
          Effect.gen(function* () {
            yield* Deferred.succeed(inside, undefined);
            yield* Effect.sleep("200 millis");
            const exit = yield* Effect.exit(lock.guard(Effect.void));
            yield* Deferred.succeed(nested, Exit.isSuccess(exit));
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);
      const started = Date.now();
      const moved = yield* Effect.exit(lock.alone(Effect.void, "3 seconds"));
      const waited = Date.now() - started;
      yield* Fiber.join(change);
      return {
        moved: Exit.isSuccess(moved),
        nested: yield* Deferred.await(nested),
        quick: waited < 1500,
      };
    }),
  )) as { moved: boolean; nested: boolean; quick: boolean };
  assert.deepEqual(result, { moved: true, nested: true, quick: true });
});

// Two asking for the lock alone at once (two starts settling what a
// crash left): one refused its reservation drops its connection, so it
// holds no read that would keep the one reserved from committing, and
// gets the lock in turn.
it("lets the one reserved commit while another process asks for the lock alone", async () => {
  const home = mkdtempSync(join(tmpdir(), "engine-lock-"));
  try {
    const lockFile = join(
      home,
      ".config",
      flavorNames("dev").configDir,
      "data-dir.lock",
    );
    const ask = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          process.execPath,
          [join(import.meta.dirname, "fixtures", "aloneChild.ts"), home],
          { stdio: "inherit" },
        );
        child.once("exit", (code) => resolve(code));
      });
    // The lock's table made, as any start's settle leaves it.
    assert.equal(await ask(), 0);
    const first = new DatabaseSync(lockFile);
    first.exec("PRAGMA locking_mode = EXCLUSIVE");
    first.exec("BEGIN IMMEDIATE");
    first.exec("INSERT OR REPLACE INTO held (id) VALUES (1)");
    const second = ask();
    // Long enough for the other to be asking.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let committed = false;
    for (let tries = 0; tries < 20 && !committed; tries += 1) {
      try {
        first.exec("COMMIT");
        committed = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    first.close();
    assert.equal(committed, true, "the one reserved committed");
    assert.equal(await second, 0, "the other had it in turn");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A lock file that isn't a lock database refuses every move, and lets
// the changes run, as one this user can't write does.
it("lets a change run, and refuses a move, when the lock file isn't a database", async () => {
  const result = (await box.engine(
    Effect.gen(function* () {
      const { pointerFile } = yield* Paths.Paths;
      mkdirSync(dirname(pointerFile), { recursive: true });
      writeFileSync(
        join(dirname(pointerFile), "data-dir.lock"),
        "x".repeat(4096),
      );
      const lock = yield* DataDirLock.DataDirLock;
      const changed = yield* Effect.exit(lock.guard(Effect.void));
      const moved = yield* Effect.exit(lock.alone(Effect.void, "200 millis"));
      return {
        changed: Exit.isSuccess(changed),
        refusal: Option.getOrUndefined(Exit.findErrorOption(moved)),
      };
    }),
  )) as { changed: boolean; refusal: unknown };
  assert.equal(result.changed, true);
  assert.ok(result.refusal instanceof DataDirLock.DataDirLockUnavailable);
  assert.match(String(result.refusal), /not a database/);
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
      }).pipe(Effect.provide(lockAtHome(home))),
    );
    assert.ok(
      Option.getOrUndefined(Exit.findErrorOption(exit)) instanceof
        DataDirLock.DataDirMoved,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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

// port-pool keys a lease by folder, and only at the new place does the
// layout count a moved worktree managed: the first start there carries
// each one's lease.
it("carries each moved worktree's port-pool lease when the move settles at the new place, one the journal doesn't name too", async () => {
  box.write("config.json", { portPool: true });
  const dataDir = box.side("engine");
  const log = join(box.home, "port-pool.log");
  box.fakeBin("port-pool", `echo "$@" >> ${log}`);
  const repo = box.repo("proj", {
    "README.md": "hi\n",
    "port-pool.config.json": '{"schemaVersion":1}\n',
  });
  const oldPath = join(box.home, "old-data", "wt", "proj", "fox");
  const newPath = join(dataDir, "wt", "proj", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", newPath);
  // One the journal doesn't name, which git still lists where it was.
  const oldOwl = join(box.home, "old-data", "wt", "proj", "owl");
  const newOwl = join(dataDir, "wt", "proj", "owl");
  box.git(repo, "worktree", "add", "-q", "-b", "owl", oldOwl);
  renameSync(oldOwl, newOwl);
  const projectId = (await box.engine(
    Effect.map(
      Effect.flatMap(Registry.Registry, (registry) =>
        registry.register({ name: "proj", path: repo }),
      ),
      ({ id }) => id,
    ),
  )) as string;
  writeFileSync(
    join(dataDir, JOURNAL),
    JSON.stringify({
      from: join(box.home, "old-data"),
      to: dataDir,
      partial: null,
      moved: [{ projectId, oldPath, newPath, capture: null, state: "rekeyed" }],
    }),
  );
  await settleAt(dataDir);
  assert.equal(existsSync(join(dataDir, JOURNAL)), false);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    `release ${oldPath}`,
    `ensure ${newPath}`,
    `release ${oldOwl}`,
    `ensure ${newOwl}`,
  ]);
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
