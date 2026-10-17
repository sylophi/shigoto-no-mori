// The data-folder move's recovery as every engine process runs it (V3.md,
// Commit points): while a move's journal is in the data dir the store
// refuses every process's writes, and the next engine graph to come up,
// the terminal's as much as the app's, settles it first.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, it } from "vitest";
import * as SqlClient from "effect/sql/SqlClient";
import { finishMove, resumeDataDirMove } from "../src/dataDirMove.ts";
import {
  CLAIMED,
  JOURNAL,
  retireStore,
  reviveStore,
} from "../src/dataDirMoveJournal.ts";
import * as Registry from "../src/Registry.ts";
import * as WorktreeData from "../src/WorktreeData.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;

// The settle as a graph runs it coming up, on the sandbox's platform.
const settleAt = (dir: string) =>
  box.engine(resumeDataDirMove(dir).pipe(Effect.provide(NodeServices.layer)));
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

// A journal a live recovery claimed is that recovery's; one whose
// claimer is gone is taken over and settled.
it("leaves a journal a live process claimed, and takes over one whose claimer is gone", async () => {
  const dataDir = box.side("engine");
  await box.engine(Effect.void);
  const journal = JSON.stringify({
    from: dataDir,
    to: join(box.home, "never-landed"),
    partial: null,
    pid: 4_194_304,
    startedAt: 0,
    moved: [],
  });
  // The test's parent is running, and isn't this process.
  const live = `${CLAIMED}${process.ppid}`;
  writeFileSync(join(dataDir, live), journal);
  await settleAt(dataDir);
  assert.ok(existsSync(join(dataDir, live)));
  rmSync(join(dataDir, live));
  writeFileSync(join(dataDir, `${CLAIMED}4194304`), journal);
  await settleAt(dataDir);
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => name.startsWith("data-dir-move")),
    [],
  );
});

// Every mutation's first write is its own row, which a move's refusal
// turns down: a capture-only re-key and a create (whose git work comes
// before any other write) are refused, and git is left as it was.
it("refuses a capture-only re-key and a create while a move owns the store", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const from = "aaaaaaaaaaaa";
  const head = box.git(repo, "rev-parse", "HEAD").trim();
  box.git(repo, "update-ref", `refs/shigomori/dirty/${from}`, head);
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      yield* retireStore;
      const rekeyed = yield* Effect.exit(
        worktrees.rekey(project, from, join(box.home, "elsewhere", "fox")),
      );
      const created = yield* Effect.exit(
        worktrees.create(
          project,
          { name: "fox", skipSetup: true },
          { report: () => Effect.void, color: false },
        ),
      );
      yield* reviveStore;
      return {
        rekeyed: Exit.isFailure(rekeyed),
        created: Exit.isFailure(created),
        listed: (yield* worktrees.identities(project)).length,
      };
    }),
  )) as { rekeyed: boolean; created: boolean; listed: number };
  assert.deepEqual(result, { rekeyed: true, created: true, listed: 1 });
  assert.equal(
    box.git(repo, "rev-parse", `refs/shigomori/dirty/${from}`).trim(),
    head,
  );
});

// A store left refusing with no journal: by a process that is gone, it
// writes again at the next settle; by one still running, it keeps
// refusing.
it("lets a store a gone process left refusing write again, and keeps a live one's refusing", async () => {
  const dataDir = box.side("engine");
  const writes = () =>
    box.engine(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        // An insert, which a refusing store always turns down: an update
        // that touches no row fires no trigger.
        sql`INSERT INTO mutations (id, pid, started_at) VALUES ('probe', 1, 0)`.pipe(
          Effect.andThen(sql`DELETE FROM mutations WHERE id = 'probe'`),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      ),
    ) as Promise<boolean>;
  const ownedBy = (pid: number) =>
    box.engine(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* retireStore;
        yield* sql`UPDATE retired_by SET pid = ${pid}, started_at = 0`;
      }),
    );
  await ownedBy(process.ppid);
  await settleAt(dataDir);
  assert.equal(await writes(), false);
  await ownedBy(4_194_304);
  await settleAt(dataDir);
  assert.equal(await writes(), true);
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
      pid: 4_194_304,
      startedAt: 0,
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
    pid: 4_194_304,
    startedAt: 0,
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
