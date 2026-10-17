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
// they asked for it here (the shell's dialog). A data folder reached
// through a link carries its worktrees, which git names by the link's
// target (or spelled with trailing slashes), to their ids at the
// destination's target, and one that is itself a link is refused.
//
// Run: pnpm test data-dir-move.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
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
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
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
  // What a landed copy left: the old tree with the journal it was copied
  // with, and that journal at the new place, which the pointer names with
  // a slash at its end.
  const old = join(elsewhere, "old-data");
  mkdirSync(old);
  const journal = JSON.stringify({
    from: old,
    to: `${engineDataDir}/`,
    partial: `${engineDataDir}.partial-x`,
    pid: 4_194_304,
    startedAt: 0,
    moved: [
      { projectId, oldPath: join(old, "wt", "repo", "fox"), newPath: fox },
    ],
  });
  writeFileSync(join(old, JOURNAL), journal);
  writeFileSync(join(engineDataDir, JOURNAL), journal);
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(await titleOf(identity.id), "Fox", "nothing re-keyed back");
  assert.equal(existsSync(old), false, "the old tree removed");
  assert.equal(
    readdirSync(engineDataDir).includes("data-dir-move.json"),
    false,
  );
});

it("a finished move whose worktree links couldn't be repaired keeps its journal for the next start", async () => {
  const old = join(elsewhere, "old-data-unrepaired");
  mkdirSync(old);
  const journal = join(engineDataDir, JOURNAL);
  writeFileSync(
    journal,
    JSON.stringify({
      from: old,
      to: engineDataDir,
      partial: null,
      pid: 4_194_304,
      startedAt: 0,
      moved: [
        {
          projectId,
          oldPath: join(old, "wt", "repo", "gone"),
          newPath: join(elsewhere, "not-a-worktree"),
        },
      ],
    }),
  );
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(
    existsSync(journal),
    true,
    "the journal went with a repair owed",
  );
  rmSync(journal);
});

it("a kept journal of a copied move never deletes a folder made at the old place since", async () => {
  const old = join(elsewhere, "old-data-remade");
  mkdirSync(old);
  writeFileSync(join(old, "new.txt"), "made after the move\n");
  const journal = join(engineDataDir, JOURNAL);
  writeFileSync(
    journal,
    JSON.stringify({
      from: old,
      to: engineDataDir,
      partial: `${engineDataDir}.partial-x`,
      pid: 4_194_304,
      startedAt: 0,
      moved: [
        {
          projectId,
          oldPath: join(old, "wt", "repo", "gone"),
          newPath: join(elsewhere, "not-a-worktree"),
        },
      ],
    }),
  );
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(
    readFileSync(join(old, "new.txt"), "utf8"),
    "made after the move\n",
  );
  rmSync(journal);
  rmSync(old, { recursive: true });
});

it("a copied move whose old tree couldn't be removed keeps its journal, and the next start removes it", async () => {
  const old = join(elsewhere, "old-data-stuck");
  const stuck = join(old, "stuck");
  mkdirSync(stuck, { recursive: true });
  writeFileSync(join(stuck, "file"), "");
  const journal = JSON.stringify({
    from: old,
    to: engineDataDir,
    partial: `${engineDataDir}.partial-stuck`,
    pid: 4_194_304,
    startedAt: 0,
    moved: [],
  });
  writeFileSync(join(old, JOURNAL), journal);
  writeFileSync(join(engineDataDir, JOURNAL), journal);
  chmodSync(stuck, 0o555);
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(existsSync(join(old, JOURNAL)), true, "the old tree still ours");
  assert.equal(
    existsSync(join(engineDataDir, JOURNAL)),
    true,
    "the journal kept with the old tree owed",
  );
  chmodSync(stuck, 0o755);
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(existsSync(old), false, "the old tree removed");
  assert.equal(existsSync(join(engineDataDir, JOURNAL)), false);
});

// Sol's round 4: an old tree whose journal can't be read can't be told
// for this move's, so the finish keeps its own until it can.
it("a finish that can't read the old tree's journal keeps its own, and finishes once it can", async () => {
  const old = join(elsewhere, "old-data-unread");
  mkdirSync(old);
  const journal = JSON.stringify({
    from: old,
    to: engineDataDir,
    partial: `${engineDataDir}.partial-unread`,
    pid: 4_194_304,
    startedAt: 0,
    moved: [],
  });
  writeFileSync(join(old, JOURNAL), journal);
  writeFileSync(join(engineDataDir, JOURNAL), journal);
  chmodSync(join(old, JOURNAL), 0o000);
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(existsSync(join(engineDataDir, JOURNAL)), true);
  chmodSync(join(old, JOURNAL), 0o644);
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(join(engineDataDir, JOURNAL)), false);
});

// Sol's round 4: an undo reverses by each entry's mark. A `planned` entry
// whose re-key ran before a crash took its mark is reversed; a
// `returned` one never again, whatever is under its new id since.
it("an undo reverses a planned entry its re-key reached, and never a returned one", async () => {
  const identity = (
    await runHost(Ops.listWorktreeIdentities({ projectId }))
  ).find((row) => row.path === fox);
  assert.ok(identity !== undefined);
  const newPath = join(elsewhere, "marks", "wt", "repo", "fox");
  const newId = worktreeIdFromPath(newPath);
  const journalAt = (state: string) =>
    writeFileSync(
      join(engineDataDir, JOURNAL),
      JSON.stringify({
        from: engineDataDir,
        to: join(elsewhere, "marks-never-landed"),
        partial: null,
        pid: 4_194_304,
        startedAt: 0,
        moved: [{ projectId, oldPath: fox, newPath, capture: null, state }],
      }),
    );
  await runHost(Ops.rekeyWorktree(projectId, identity.id, newPath));
  assert.equal(await titleOf(identity.id), undefined, "the re-key ran");
  journalAt("planned");
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(await titleOf(identity.id), "Fox", "a planned re-key reversed");
  assert.equal(existsSync(join(engineDataDir, JOURNAL)), false);

  await runHost(Ops.rekeyWorktree(projectId, identity.id, newPath));
  journalAt("returned");
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(await titleOf(identity.id), undefined, "a returned entry left");
  assert.equal(await runHost(Ops.keptUnder(projectId, newId)), true);
  await runHost(
    Ops.rekeyWorktree(projectId, newId, fox, { expect: null, back: true }),
  );
  assert.equal(await titleOf(identity.id), "Fox");
});

it("keeps a move journal it can't read, which may be all that says what a move left", async () => {
  const journal = join(engineDataDir, JOURNAL);
  writeFileSync(journal, "not a journal");
  await runHost(Effect.scoped(Layer.build(resumeLayer)));
  assert.equal(readFileSync(journal, "utf8"), "not a journal");
  rmSync(journal);
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

it.each([
  ["reached through a link", "linked"],
  ["spelled with trailing slashes", "slashes"],
])(
  "a data folder %s, moved through a link, carries its worktrees to the ids git will name them by",
  async (_, spelling) => {
    const identity = (
      await runHost(Ops.listWorktreeIdentities({ projectId }))
    ).find((row) => row.path === fox);
    assert.ok(identity !== undefined, "the worktree in the data folder");
    const project = (await runHost(Ops.listProjects())).find(
      (one) => one.id === projectId,
    );
    assert.ok(project !== undefined);
    await runHost(Ops.describe(project, identity.id, { title: "Fox" }));
    let dataDir = `${engineDataDir}///`;
    if (spelling === "linked") {
      const linked = join(elsewhere, "linked");
      symlinkSync(dirname(engineDataDir), linked);
      dataDir = join(linked, basename(engineDataDir));
    }
    // The destination reached through a link too: git will name the
    // moved worktree by its target.
    const target = join(elsewhere, `${spelling}-target`);
    mkdirSync(target);
    const parent = join(elsewhere, `${spelling}-to`);
    symlinkSync(target, parent);
    const movedFox = join(target, "moved", "wt", "repo", "fox");
    const moved = await runHost(
      moveDataDir(parent, {
        place: {
          dataDir,
          pointerFile: join(elsewhere, `config-${spelling}`, "data-dir"),
          legacyPointerFile: null,
          defaultDataDir: join(elsewhere, "home", ".sm"),
          dataDirName: "moved",
        },
        // The re-key is done by now. Failing here undoes the move before
        // anything moved.
        beforeMove: Effect.gen(function* () {
          const journal = JSON.parse(
            readFileSync(join(engineDataDir, JOURNAL), "utf8"),
          ) as { moved: { oldPath: string; newPath: string }[] };
          assert.deepEqual(
            journal.moved.map((one) => [one.oldPath, one.newPath]),
            [[fox, movedFox]],
          );
          assert.equal(
            yield* Effect.promise(() => titleOf(identity.id)),
            undefined,
            "the title re-keyed",
          );
          return yield* Effect.fail("stop before the folder moves");
        }),
        killAllScripts: Effect.void,
      }).pipe(Effect.flip),
    );
    assert.equal(moved, "stop before the folder moves");
    assert.equal(await titleOf(identity.id), "Fox", "undone");
  },
);

const ref = (id: string) => `refs/shigomori/dirty/${id}`;

// A move undone before its folder moved carries back the dirty capture
// its re-key carried; one kept under a new id from before refuses the
// move before anything moves.
it.each([
  ["one kept under the new id refuses the move", false],
  ["its own comes back", true],
])("a move and its undo and a capture: %s", async (_name, own) => {
  const repo = join(elsewhere, "repo");
  const identity = (
    await runHost(Ops.listWorktreeIdentities({ projectId }))
  ).find((row) => row.path === fox);
  assert.ok(identity !== undefined);
  const parent = join(elsewhere, `captures-${String(own)}`);
  mkdirSync(parent);
  const newId = worktreeIdFromPath(
    join(realpathSync(parent), "moved", "wt", "repo", "fox"),
  );
  const head = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "update-ref", ref(own ? identity.id : newId), head);
  const failed = await runHost(
    moveDataDir(parent, {
      place: {
        dataDir: engineDataDir,
        pointerFile: join(
          elsewhere,
          `config-captures-${String(own)}`,
          "data-dir",
        ),
        legacyPointerFile: null,
        defaultDataDir: join(elsewhere, "home", ".sm"),
        dataDirName: "moved",
      },
      // The re-key is done by now: an own capture is under the new id.
      beforeMove: Effect.gen(function* () {
        const tip = git(
          repo,
          "for-each-ref",
          "--format=%(objectname)",
          ref(newId),
        ).trim();
        assert.equal(tip, head);
        return yield* Effect.fail("stop before the folder moves");
      }),
      killAllScripts: Effect.void,
    }).pipe(Effect.flip),
  );
  if (own) assert.equal(failed, "stop before the folder moves");
  else assert.match(String(failed), /Something is still kept/);
  const tip = (id: string) =>
    git(repo, "for-each-ref", "--format=%(objectname)", ref(id)).trim();
  assert.deepEqual(
    { own: tip(identity.id), kept: tip(newId) },
    own ? { own: head, kept: "" } : { own: "", kept: head },
  );
  git(repo, "update-ref", "-d", ref(own ? identity.id : newId));
});

// Sol's round 3: a capture made while the scripts are killed, before the
// journal, is the one the move carries and an undo brings back.
it("a capture made while a move kills the scripts comes back with its undo", async () => {
  const repo = join(elsewhere, "repo");
  const identity = (
    await runHost(Ops.listWorktreeIdentities({ projectId }))
  ).find((row) => row.path === fox);
  assert.ok(identity !== undefined);
  const parent = join(elsewhere, "captures-late");
  mkdirSync(parent);
  const newId = worktreeIdFromPath(
    join(realpathSync(parent), "moved", "wt", "repo", "fox"),
  );
  const head = git(repo, "rev-parse", "HEAD").trim();
  const failed = await runHost(
    moveDataDir(parent, {
      place: {
        dataDir: engineDataDir,
        pointerFile: join(elsewhere, "config-captures-late", "data-dir"),
        legacyPointerFile: null,
        defaultDataDir: join(elsewhere, "home", ".sm"),
        dataDirName: "moved",
      },
      killAllScripts: Effect.sync(() => {
        git(repo, "update-ref", ref(identity.id), head);
      }),
      beforeMove: Effect.fail("stop before the folder moves"),
    }).pipe(Effect.flip),
  );
  assert.equal(failed, "stop before the folder moves");
  const tip = (id: string) =>
    git(repo, "for-each-ref", "--format=%(objectname)", ref(id)).trim();
  assert.deepEqual(
    { own: tip(identity.id), moved: tip(newId) },
    { own: head, moved: "" },
  );
  git(repo, "update-ref", "-d", ref(identity.id));
});

// Sol's round 3: a move never writes its journal over one still owed.
it("a move settles an earlier move's journal first, and waits while it can't", async () => {
  const journal = join(engineDataDir, JOURNAL);
  const place = (name: string) => ({
    dataDir: engineDataDir,
    pointerFile: join(elsewhere, `config-${name}`, "data-dir"),
    legacyPointerFile: null,
    defaultDataDir: join(elsewhere, "home", ".sm"),
    dataDirName: "moved",
  });
  const tryMove = (name: string) => {
    const parent = join(elsewhere, name);
    mkdirSync(parent);
    return runHost(
      moveDataDir(parent, {
        place: place(name),
        killAllScripts: Effect.void,
        beforeMove: Effect.fail("stop before the folder moves"),
      }).pipe(Effect.flip),
    );
  };
  writeFileSync(journal, "not a journal");
  assert.match(String(await tryMove("unsettled")), /isn't finished or undone/);
  assert.equal(readFileSync(journal, "utf8"), "not a journal");
  // One a start can settle: a move to elsewhere that never landed.
  writeFileSync(
    journal,
    JSON.stringify({
      from: engineDataDir,
      to: join(elsewhere, "never-landed"),
      partial: null,
      pid: 4_194_304,
      startedAt: 0,
      moved: [],
    }),
  );
  assert.equal(await tryMove("settled"), "stop before the folder moves");
  assert.equal(existsSync(journal), false);
});

it.each([
  ["", "alias"],
  ["///", "alias-slashes"],
])(
  "a data folder that is itself a link, spelled with %j after it, is refused",
  async (trailing, name) => {
    const alias = join(elsewhere, name);
    symlinkSync(engineDataDir, alias);
    const refused = await runHost(
      moveDataDir(join(elsewhere, `${name}-to`), {
        place: {
          dataDir: `${alias}${trailing}`,
          pointerFile: join(elsewhere, "config-alias", "data-dir"),
          legacyPointerFile: null,
          defaultDataDir: join(elsewhere, "home", ".sm"),
          dataDirName: "moved",
        },
        beforeMove: Effect.void,
        killAllScripts: Effect.void,
      }).pipe(Effect.flip),
    );
    assert.match(String(refused), /is a link to/);
    assert.equal(existsSync(join(elsewhere, `${name}-to`)), false);
  },
);
