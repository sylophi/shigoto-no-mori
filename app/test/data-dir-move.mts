// Durable proof that a data-folder move a crash cut short is undone at
// the next start (host/lib/dataDirMove.ts). The move re-keys every
// worktree under the data folder before it copies, so a crash mid-copy
// left the store keyed to paths that never came to be, and the partial
// copy refused every retry. Asserts, for a move to another volume (the
// rename refused across volumes) whose copy stops halfway and is never
// heard from again, as in a crash:
//   - while it hangs, the worktree's title is under its new id, and the
//     partial copy sits beside the destination, not at it;
//   - the next start's resume (the layer the host's graph runs at
//     start) puts the title back under the worktree's
//     own id, removes the partial copy and the journal, and the pointer
//     was never written.
// And for one whose copy landed whole but whose pointer was never
// written: the next start undoes it the same way and removes the copy,
// which would refuse every retry. A rename a crash cut before the
// pointer moved is found by the folder that arrived, its journal naming
// the one that left, and the pointer committed. The copy holds the
// store still, so no write tears it. And one that failed after the host let
// go of the folder restarts the app, once its user has read why when
// they asked for it here (the shell's dialog).
//
// Run: pnpm test data-dir-move.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { afterAll, beforeAll, it } from "vitest";
import {
  holdingStore,
  moveDataDir,
  resumeLayer,
} from "../host/lib/dataDirMove.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  JOURNAL,
  rescueStrandedMove,
  reviveStore,
} from "@shigomori/engine/dataDirMoveJournal";
import { afterFailedMove } from "../host/ipc/modules/runtime.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import {
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";

scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let elsewhere: string;
let projectId: string;
let fox: string;

beforeAll(async () => {
  initDataDirAt(engineDataDir);
  elsewhere = tempDir("sm-data-move-", track);
  const repo = join(elsewhere, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
  // A worktree the data folder holds, as the app makes them.
  fox = join(engineDataDir, "wt", "repo", "fox");
  git(repo, "worktree", "add", "-q", "-b", "fox", fox);
  const project = await runHost(addProject(repo));
  projectId = project.id;
});
afterAll(teardown);

// Another volume: the data folder can't be renamed there. `stall`
// names the renames the crash stops for good.
const acrossVolumes = (
  real: FileSystem.FileSystem,
  stall: (from: string) => boolean = () => false,
): FileSystem.FileSystem => ({
  ...real,
  rename: (from, to) =>
    from === engineDataDir
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: from,
            cause: Object.assign(new Error("cross-device link"), {
              code: "EXDEV",
            }),
          }),
        )
      : stall(from)
        ? Effect.never
        : real.rename(from, to),
});

const titleOf = (worktreeId: string) =>
  runHost(Ops.describeWorktree(projectId, worktreeId)).then(
    (row) => row.title,
    () => undefined,
  );

it("a move to another volume that crashed mid-copy is undone at the next start", async () => {
  const identity = (
    await runHost(Ops.listWorktreeIdentities({ projectId }))
  ).find((row) => row.path === fox);
  assert.ok(identity !== undefined, "the worktree in the data folder");
  const project = (await runHost(Ops.listProjects())).find(
    (one) => one.id === projectId,
  );
  assert.ok(project !== undefined);
  await runHost(Ops.describe(project, identity.id, { title: "Fox" }));
  assert.equal(await titleOf(identity.id), "Fox");

  const parent = join(elsewhere, "volume");
  const destination = join(parent, "moved");
  const pointerFile = join(elsewhere, "config", "data-dir");
  const copying = Deferred.makeUnsafe<string>();
  const move = runHost(
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const fs = acrossVolumes(real);
      return yield* moveDataDir(parent, {
        place: {
          dataDir: engineDataDir,
          pointerFile,
          legacyPointerFile: null,
          defaultDataDir: join(elsewhere, "home", ".sm"),
          dataDirName: "moved",
        },
        beforeMove: Effect.void,
        killAllScripts: Effect.void,
        // Half the tree, then nothing more: the app was killed.
        copy: (_from, to) =>
          Effect.gen(function* () {
            yield* real.makeDirectory(to, { recursive: true });
            yield* real.writeFileString(join(to, "half"), "");
            yield* Deferred.succeed(copying, to);
            return yield* Effect.never;
          }),
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    }).pipe(Effect.forkDetach),
  );
  const crashed = await move;
  const partial = await Effect.runPromise(Deferred.await(copying));

  assert.equal(
    await titleOf(identity.id),
    undefined,
    "the re-key ran before the copy",
  );
  assert.equal(existsSync(destination), false, "the copy fills a sibling");
  assert.equal(existsSync(partial), true);

  // The next start, the pointer where it was.
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(
    await titleOf(identity.id),
    "Fox",
    "the title back under the worktree's own id",
  );
  assert.equal(existsSync(partial), false, "the partial copy removed");
  assert.equal(
    readdirSync(engineDataDir).includes("data-dir-move.json"),
    false,
    "the journal removed",
  );
  assert.equal(existsSync(pointerFile), false, "no pointer committed");
  await Effect.runPromise(Fiber.interrupt(crashed));
});

it("a move whose copy landed but whose pointer was never written is undone, its copy removed", async () => {
  const identity = (
    await runHost(Ops.listWorktreeIdentities({ projectId }))
  ).find((row) => row.path === fox);
  assert.ok(identity !== undefined);
  assert.equal(await titleOf(identity.id), "Fox");
  const parent = join(elsewhere, "volume-2");
  const destination = join(parent, "moved");
  const pointerFile = join(elsewhere, "config-2", "data-dir");
  const crashed = await runHost(
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      return yield* moveDataDir(parent, {
        place: {
          dataDir: engineDataDir,
          pointerFile,
          legacyPointerFile: null,
          defaultDataDir: join(elsewhere, "home", ".sm"),
          dataDirName: "moved",
        },
        beforeMove: Effect.void,
        killAllScripts: Effect.void,
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          // The app is killed as it commits the pointer.
          acrossVolumes(real, (from) => from.startsWith(`${pointerFile}.tmp`)),
        ),
      );
    }).pipe(Effect.forkDetach),
  );
  await waitFor(() => existsSync(destination), "the copy renamed in");
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(await titleOf(identity.id), "Fox");
  assert.equal(existsSync(destination), false, "the copy removed");
  assert.equal(existsSync(pointerFile), false, "no pointer committed");
  await Effect.runPromise(Fiber.interrupt(crashed));
});

it("a journal naming this folder with a trailing slash finishes the move, never undoes it", async () => {
  const identity = (
    await runHost(Ops.listWorktreeIdentities({ projectId }))
  ).find((row) => row.path === fox);
  assert.ok(identity !== undefined);
  // What a landed copy left: the old tree, and the journal at the new
  // place, which the pointer names with a slash at its end.
  const old = join(elsewhere, "old-data");
  mkdirSync(old);
  writeFileSync(
    join(engineDataDir, "data-dir-move.json"),
    JSON.stringify({
      from: old,
      to: `${engineDataDir}/`,
      partial: `${engineDataDir}.partial-x`,
      pid: 4_194_304,
      startedAt: 0,
      moved: [
        { projectId, oldPath: join(old, "wt", "repo", "fox"), newPath: fox },
      ],
    }),
  );
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(await titleOf(identity.id), "Fox", "nothing re-keyed back");
  assert.equal(existsSync(old), false, "the old tree removed");
  assert.equal(
    readdirSync(engineDataDir).includes("data-dir-move.json"),
    false,
  );
});

it("a move that failed after the folder was let go never leaves the app running without it", () => {
  // Before the release, the app carries on where it was.
  assert.equal(
    afterFailedMove({ watchersStopped: false, unattended: false }),
    "carry-on",
  );
  assert.equal(
    afterFailedMove({ watchersStopped: false, unattended: true }),
    "carry-on",
  );
  // After it: asked here, the user reads why and restarts (or quits);
  // asked by a peer, the app restarts with nobody to ask.
  assert.equal(
    afterFailedMove({ watchersStopped: true, unattended: false }),
    "ask",
  );
  assert.equal(
    afterFailedMove({ watchersStopped: true, unattended: true }),
    "relaunch",
  );
});

// A write from another process, or why it was refused.
function writeTheStore(): string {
  const other = new DatabaseSync(join(engineDataDir, "store.db"));
  try {
    other.exec("UPDATE changes SET version = version + 1");
    return "written";
  } catch (error) {
    return String(error);
  } finally {
    other.close();
  }
}

it("holds the store still while a move copies it to another volume", async () => {
  const refused = await runHost(
    holdingStore(
      Effect.sync(() => {
        const other = new DatabaseSync(join(engineDataDir, "store.db"), {
          timeout: 0,
        });
        try {
          other.exec("UPDATE changes SET version = version + 1");
          return "written";
        } catch (error) {
          return String(error);
        } finally {
          other.close();
        }
      }),
    ),
  );
  assert.match(refused, /locked|busy/i, "another process's write waits");
  // And once the copy is made, the store left behind refuses the write
  // that waited, until an undone move revives it.
  assert.match(writeTheStore(), /sm-data-folder-moved/);
  await runHost(reviveStore);
  assert.equal(writeTheStore(), "written");
});

// A data folder a move landed, its journal naming where it came from.
function landed(at: string, from: string, partial: string | null = null): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "store.db"), "");
  writeFileSync(
    join(at, JOURNAL),
    JSON.stringify({
      from,
      to: at,
      partial,
      pid: 4_194_304,
      startedAt: 0,
      moved: [],
    }),
  );
}

// A move a crash cut between moving the folder and moving the pointer:
// the folder that arrived holds the journal, naming the one that left.
it("finds a data folder whose move a crash cut before its pointer moved", async () => {
  const root = tempDir("sm-data-rescue-", track);
  const config = join(root, "config");
  mkdirSync(config);
  const pointerFile = join(config, "data-dir");
  const defaultDataDir = join(root, "home", ".sm");
  const custom = join(root, "drive", ".sm");
  const rescue = (named: string) =>
    Effect.runPromise(
      rescueStrandedMove({
        named,
        pointerFile,
        legacyPointerFile: null,
        defaultDataDir,
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  // From the default: the pointer was staged beside itself.
  landed(custom, defaultDataDir);
  writeFileSync(`${pointerFile}.tmp.ab12`, `${custom}\n`);
  assert.equal(await rescue(defaultDataDir), custom);
  assert.equal(readFileSync(pointerFile, "utf8").trim(), custom);
  assert.equal(existsSync(`${pointerFile}.tmp.ab12`), false);
  rmSync(join(custom, JOURNAL));

  // Back to the default: the pointer still names the folder that left.
  landed(defaultDataDir, custom);
  rmSync(custom, { recursive: true });
  assert.equal(await rescue(custom), defaultDataDir);
  assert.equal(existsSync(pointerFile), false);

  // A copy keeps its source and journal, which the start undoes instead.
  landed(custom, defaultDataDir);
  writeFileSync(
    join(defaultDataDir, JOURNAL),
    JSON.stringify({
      from: defaultDataDir,
      to: custom,
      partial: "x",
      pid: 4_194_304,
      startedAt: 0,
      moved: [],
    }),
  );
  writeFileSync(`${pointerFile}.tmp.cd34`, `${custom}\n`);
  assert.equal(await rescue(defaultDataDir), null);
  assert.equal(existsSync(pointerFile), false);

  // A copy's journal never counts, even with its source out of sight (a
  // drive unplugged as the copy was undone): only a rename's does.
  rmSync(defaultDataDir, { recursive: true });
  rmSync(custom, { recursive: true });
  landed(custom, defaultDataDir, join(root, "drive", ".sm.partial-x"));
  assert.equal(await rescue(defaultDataDir), null);
  assert.equal(existsSync(pointerFile), false);

  // And a journal about another folder is none of this one's.
  assert.equal(await rescue(join(root, "elsewhere")), null);
});

it("a rename interrupted before its pointer moved keeps the staged pointer the next start finds it by", async () => {
  const parent = join(elsewhere, "same-volume");
  const destination = join(parent, "moved");
  const pointerFile = join(elsewhere, "config-3", "data-dir");
  const staging = Deferred.makeUnsafe<void>();
  const move = runHost(
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const fs: FileSystem.FileSystem = {
        ...real,
        rename: (from, to) =>
          to === pointerFile
            ? Deferred.succeed(staging, undefined).pipe(
                Effect.andThen(Effect.never),
              )
            : real.rename(from, to),
      };
      return yield* moveDataDir(parent, {
        place: {
          dataDir: engineDataDir,
          pointerFile,
          legacyPointerFile: null,
          defaultDataDir: join(elsewhere, "home", ".sm"),
          dataDirName: "moved",
        },
        beforeMove: Effect.void,
        killAllScripts: Effect.void,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    }).pipe(Effect.forkDetach),
  );
  const fiber = await move;
  await Effect.runPromise(Deferred.await(staging));
  await Effect.runPromise(Fiber.interrupt(fiber));
  try {
    assert.ok(existsSync(join(destination, "data-dir-move.json")));
    const staged = readdirSync(dirname(pointerFile)).filter((entry) =>
      entry.startsWith("data-dir.tmp."),
    );
    assert.equal(staged.length, 1, "the staged pointer stays");
    const found = await Effect.runPromise(
      rescueStrandedMove({
        named: engineDataDir,
        pointerFile,
        legacyPointerFile: null,
        defaultDataDir: join(elsewhere, "home", ".sm"),
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.equal(found, destination);
    assert.equal(readFileSync(pointerFile, "utf8").trim(), destination);
  } finally {
    // This process's data folder back where the other cases find it.
    renameSync(destination, engineDataDir);
    rmSync(join(engineDataDir, "data-dir-move.json"), { force: true });
  }
});
