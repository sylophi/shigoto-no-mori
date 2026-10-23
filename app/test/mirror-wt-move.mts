// Durable proof that a mirror into this device outlives the v3
// migration's move of its copy into wt/
// (packages/engine/src/WtFolder.ts). A worktree's id is a hash of its
// path, so the move gives the copy a new one while the device running
// the mirror still names it by its v2 id. Starts from a v2 data
// dir: a project with the copy under the v2 `worktrees/` root. The
// engine comes up on it as a first v3 start does (the store's import,
// then the move), and the copy's device serves the runner's calls over
// a REAL direct wire. Asserts:
//   - the start moved the copy into wt/,
//   - a stream the runner's daemon opens by the v2 id, through the REAL
//     gateway, is served from the copy's new folder and listed under its
//     new id,
//   - the git follower, on a session naming the v2 id, reads the copy
//     and reports synced, never the copy gone,
//   - a rename while the app runs leaves every id the copy had naming
//     it, and an id a live worktree has is never taken for the one its
//     old worktree moved to.
//
// The runner's copy-gone check (sessions.ts copyIsGone) still reads the
// peer's list, which names the copy by its new id only; the follower
// above doesn't ask it, since its reads resolve.
//
// Run: pnpm test mirror-wt-move.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { afterAll, beforeAll, it } from "vitest";
import * as FileSync from "@host/fileSync/FileSync";
import * as PeerReach from "@host/ipc/PeerReach";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { findProjectAndWorktree } from "@host/lib/projects";
import * as MirrorGateway from "@host/mirror/MirrorGateway";
import { makeGitFollower } from "@host/mirror/gitFollow";
import { MIRROR_LABEL_LOCAL_PROJECT } from "@host/mirror/registry";
import { listMirrorServing } from "@host/mirror/serving";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { makeTracker, waitFor } from "./lib/checkKit.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import {
  bootDirectWire,
  DIALER,
  type DirectWire,
  LISTENER,
} from "./lib/directBoot.mts";
import { standInDeviceId, standInPeers } from "./lib/hostStandIns.mts";
import { runHost } from "./lib/hostRuntime.mts";
import { rawMirrorSession } from "./lib/mirrorFakes.mts";
import { hostEngine } from "./lib/smBinary.mts";

const COPY_PROJECT = "copy-project";
const RUNNER_PROJECT = "runner-project";

const fixture = cliSandbox("sm-mirror-wt-move-");
const { sandbox, dataDir, git, gitOut } = fixture;
const { track, teardown } = makeTracker();

let repo: string;
let v2Path: string;
let wtPath: string;
let v2Id: string;
let newId: string;
let runnerRoot: string;
let runnerId: string;
let toListener: DirectWire["toListener"];
let closeEngine: () => Promise<void>;

// The copy's side of a stream is a `file-sync serve` child over the
// copy's folder. This one holds the channel open and records the folder
// it was asked to serve.
const served: string[] = [];
const fileSync = Layer.succeed(
  FileSync.FileSync,
  FileSync.FileSync.of({
    spawn: () => Effect.die(new Error("not in this check")),
    serve: (root, _dataDir, until) =>
      Effect.gen(function* () {
        served.push(root);
        const scope = yield* Scope.make();
        yield* until.pipe(
          Effect.andThen(Scope.close(scope, Exit.void)),
          Effect.forkDetach,
        );
        return {
          pid: 0,
          scope,
          stream: new Duplex({
            read() {},
            write(_chunk, _encoding, done) {
              done();
            },
            // Ends its side as the runner's does, as a serve child would.
            final(done) {
              this.push(null);
              done();
            },
          }),
          stderr: new PassThrough(),
        };
      }),
  }),
);

const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

beforeAll(async () => {
  // ---- The v2 data dir: the copy under worktrees/ ----
  repo = await fixture.initRepo("repo");
  await fixture.commitFile(repo, "readme.txt", "base\n", "base");
  v2Path = join(dataDir, "worktrees", "repo", "feature");
  wtPath = join(dataDir, "wt", "repo", "feature");
  await git(repo, ["worktree", "add", "-q", "-b", "feature", v2Path]);
  v2Id = worktreeIdFromPath(v2Path);
  newId = worktreeIdFromPath(wtPath);
  // The runner's original: a clone's worktree on the same branch at the
  // same tip, outside any v2 root.
  const runnerRepo = await fixture.cloneRepo(repo, "runner-repo");
  runnerRoot = join(sandbox, "runner-wt");
  await git(runnerRepo, [
    "worktree",
    "add",
    "-q",
    "-b",
    "feature",
    runnerRoot,
    "origin/feature",
  ]);
  runnerId = worktreeIdFromPath(runnerRoot);
  writeJson(join(dataDir, "registry.json"), {
    projects: [
      { id: COPY_PROJECT, name: "repo", path: repo },
      { id: RUNNER_PROJECT, name: "runner-repo", path: runnerRepo },
    ],
  });

  // ---- The first v3 start: the store's import and the move ----
  ({ close: closeEngine } = await hostEngine(dataDir));

  // ---- The copy's device, which lets this one in ----
  let listener: DirectWire["listener"];
  ({ listener, toListener } = await bootDirectWire(track, {
    provide: fileSync,
    contracts: [
      [worktreesContract, worktreesHandlers],
      [mirrorContract, mirrorHandlers],
    ],
  }));
  listener.setAccepts(true);
  standInPeers({
    transportFor: () => toListener.transport,
    channelsFor: () => toListener.channels,
  });
  standInDeviceId(DIALER);
}, 120_000);

afterAll(async () => {
  await teardown();
  await closeEngine();
  await fixture.remove();
});

it("the first v3 start moved the copy into wt/", async () => {
  const listed = await gitOut(repo, "worktree", "list", "--porcelain");
  assert.ok(listed.includes(`worktree ${wtPath}\n`), listed);
  assert.ok(!existsSync(v2Path));
});

it("a stream the runner opens by the v2 id is served from the copy's new folder", async () => {
  const gateway = ManagedRuntime.make(
    MirrorGateway.layer.pipe(
      Layer.provide(
        Layer.succeed(
          PeerReach.PeerReach,
          PeerReach.make({
            transportFor: () => toListener.transport,
            channelsFor: () => toListener.channels,
          }),
        ),
      ),
    ),
  );
  track(() => gateway.dispose());
  const listening = Option.getOrThrow(
    await gateway.runPromise(
      MirrorGateway.MirrorGateway.use((gw) => gw.listening),
    ),
  );
  const [host, port] = listening.address.split(":");
  // The runner's daemon, dialing the gateway for the session's stream.
  const socket = netConnect(Number(port), host);
  track(() => socket.destroy());
  socket.write(
    `${JSON.stringify({
      token: listening.token,
      deviceId: LISTENER,
      projectId: COPY_PROJECT,
      worktreeId: v2Id,
      localWorktreeId: runnerId,
    })}\n`,
  );
  const answer = await new Promise<string>((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")));
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
  });
  assert.equal(answer, "ok");
  assert.deepEqual(served, [wtPath]);
  await waitFor(
    () => listMirrorServing().length === 1,
    "the copy's device to list the stream",
  );
  assert.equal(listMirrorServing()[0]?.worktreeId, newId);
  assert.equal(listMirrorServing()[0]?.peerDeviceId, DIALER);
  socket.destroy();
  await waitFor(
    () => listMirrorServing().length === 0,
    "the stream to end with its socket",
  );
});

it("the git follower reads the copy by the v2 id and reports synced, never the copy gone", async () => {
  const session = rawMirrorSession({
    session: "session-1",
    deviceId: LISTENER,
    projectId: COPY_PROJECT,
    worktreeId: v2Id,
    localRoot: runnerRoot,
    remoteRoot: v2Path,
    localWorktreeId: runnerId,
    labels: {
      [MIRROR_LABEL_LOCAL_PROJECT]: RUNNER_PROJECT,
    },
  });
  const gone: string[] = [];
  const scope = Scope.makeUnsafe();
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const follower = await runHost(
    makeGitFollower({
      sessions: Effect.succeed([session]),
      sweepMs: 60_000,
      onCopyGone: (copy) => gone.push(copy.session),
      log: () => {},
    }).pipe(Scope.provide(scope)),
  );
  await waitFor(
    () => follower.statusOf(session.session)?.status === "synced",
    "the follower to report synced",
    30_000,
  );
  assert.deepEqual(gone, []);
});

it("a rename while the app runs leaves every id the copy had naming it, and a live id is never taken for the one its old worktree moved to", async () => {
  // The copy renamed here: the peer's calls by any id it had still name
  // it.
  const renamed = await runHost(
    worktreesHandlers.rename({
      projectId: COPY_PROJECT,
      worktreeId: newId,
      name: "renamed",
    }),
  );
  for (const worktreeId of [v2Id, newId, renamed.id]) {
    const { worktree } = await runHost(
      findProjectAndWorktree(COPY_PROJECT, worktreeId),
    );
    assert.equal(worktree.id, renamed.id, worktreeId);
  }
  // A new worktree where the copy was, its folder then deleted by hand:
  // git still lists it, so its id is its own, not the renamed copy's.
  await git(repo, ["worktree", "add", "-q", "-b", "again", wtPath]);
  rmSync(wtPath, { recursive: true, force: true });
  await runHost(
    worktreeDataHandlers.describe({
      projectId: COPY_PROJECT,
      worktreeId: renamed.id,
      description: { title: "the copy", describedAt: 1 },
    }),
  );
  assert.equal(
    await runHost(
      worktreeDataHandlers.read({ projectId: COPY_PROJECT, worktreeId: newId }),
    ),
    null,
  );
  assert.equal(
    (
      await runHost(
        worktreeDataHandlers.read({
          projectId: COPY_PROJECT,
          worktreeId: v2Id,
        }),
      )
    )?.title,
    "the copy",
    "an id no worktree has any longer still reads the copy's",
  );
});
