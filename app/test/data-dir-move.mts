// Durable proof that a data-folder move a crash cut short is undone at
// the next start (host/lib/dataDirMove.ts). The move re-keys every
// worktree under the data folder before it copies, so a crash mid-copy
// left the store keyed to paths that never came to be, and the partial
// copy refused every retry. Asserts, for a move to another volume (the
// rename refused across volumes) whose copy stops halfway and is never
// heard from again, as in a crash:
//   - while it hangs, the worktree's title is under its new id, and the
//     partial copy sits beside the destination, not at it;
//   - the next start's resume puts the title back under the worktree's
//     own id, removes the partial copy and the journal, and the pointer
//     was never written.
//
// Run: pnpm test data-dir-move.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { afterAll, beforeAll, it } from "vitest";
import { moveDataDir, resumeDataDirMove } from "../host/lib/dataDirMove.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import {
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
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
      // Another volume: the data folder can't be renamed there.
      const fs: FileSystem.FileSystem = {
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
  await runHost(resumeDataDirMove(engineDataDir));
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
