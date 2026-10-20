// Durable proof for continuous worktree mirroring (file-sync/,
// host/mirror/*, mirror:openStream): two REAL directories converge in
// both directions through the whole production chain, with nothing on
// the sync path doubled. The dialer runs the REAL mirror daemon (a
// freshly built file-sync engine, Mutagen inside) behind the REAL
// gateway (host/mirror/MirrorGateway.ts). The gateway dials the listener's REAL
// mirror:openStream over a REAL direct websocket (brokered by the stub
// device hub exactly as production does, test/lib/directBoot.mts),
// the listener's handler spawns a REAL `file-sync serve` for a REAL registered
// worktree. Bytes cross on a byte channel of the direct socket
// (shared/remote/channels.ts, bridged by
// host/portForward/bridge.ts). The sm CLI is built too, only to
// register the fixture project the way the app would. Asserts:
//   - an ungranted peer: the gateway's open is refused, the daemon's
//     create fails with the refusal, and the listener spawned no serve child,
//   - a granted create converges seeded content both ways, including a
//     gitignored-style file, and holds the listener's .git pointer file back,
//   - live edits after the first cycle cross both ways within seconds,
//     and a delete propagates, while the device hub's forwardedCount
//     stays FLAT (only the direct socket carries the stream),
//   - the listener's serving list names the worktree and the caller while the
//     stream is up, and empties when the session is terminated, with
//     the serve child gone,
//   - the daemon's state stream reports the session in the app's
//     vocabulary (watching, both endpoints connected, cycles counted),
//   - stopping the daemon ends it and the gateway closes clean.
// Then the git follower (host/mirror/gitFollow.ts), driven against the
// same wire with the dialer's worktree a real clone of the listener's repository:
//   - a commit on the listener lands on the dialer: same tip, same branch, clean status,
//   - staging on the listener shows as staged on the dialer, without touching files,
//   - a commit on the dialer lands on the listener the same way (the push direction),
//   - commits on both sides since they agreed report diverged and move
//     nothing, and resolving on the dialer brings the session back to synced,
//   - a checkout on the listener to a branch another worktree on the dialer holds is
//     refused with the path, and checking back restores sync,
//   - a merge in progress on the listener, or a rebase on the dialer, reports blocked with
//     the operation and side named and moves nothing, and finishing it
//     resumes the follow,
//   - a half-landed apply (the dialer's ref already at the listener's tip, its index not)
//     heals to synced rather than reading as diverged,
//   - a commit waits while the engine reports the files mid-cycle (or
//     halted), staging does not, and the idle snapshot releases it,
//   - the dialer's primary checkout (the original, on the device running the
//     session) mirrored to a mirror/main worktree on the listener carries commits
//     both ways, and the listener's own main never moves.
// And a peer's removed worktree (worktrees:removal) ends only the
// sessions into that copy.
// And the sweep of sessions brought back for a device on no account
// asks about each session once.
//
// Both "devices" share one node process and one sandboxed
// SHIGOMORI_DATA_DIR. What separates them is the direct wire between them,
// which is exactly the surface this proof pins. Run: pnpm test mirror.
//
// covers: file-sync/**
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, it } from "vitest";
import * as PeerReach from "@host/ipc/PeerReach";
import { forwardContract } from "@shigomori/contracts/modules/forward";
import {
  MIRROR_LABEL_MODE,
  MIRROR_LABEL_REPLACES,
  isMirrorStopUnconfirmed,
  mirrorContract,
  type MirrorGitStatus,
  type MirrorSession,
} from "@shigomori/contracts/modules/mirror";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as FileSync from "@host/fileSync/FileSync";
import { forwardHandlers } from "@host/ipc/modules/forward";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import {
  type MirrorCreateInput,
  type MirrorEngine,
  MirrorError,
} from "@host/mirror/MirrorEngine";
import { listMirrorServing } from "@host/mirror/serving";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { type GitFollower, makeGitFollower } from "@host/mirror/gitFollow";
import {
  beginTransfer,
  carriedLabels,
  COPY_GONE_DETAIL,
  createNoAccountSweep,
  endMirrorsOnPeerRemoval,
  endMirrorsWithPeers,
  mirrorSessions,
  type MirrorSessionRaw,
  holdRootChecks,
  isOrphanedTransfer,
  isTransferSession,
  onMirrorBranch,
  ORIGINAL_GONE_DETAIL,
  settleMirrorBookkeeping,
  transferModeFor,
  stopMirrorsForWorktree,
  whileRecreating,
  moveMirrorsOfWorktree,
} from "@host/mirror/registry";
import { transferFilesOnce } from "@host/mirror/oneShot";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as MirrorDaemon from "../host/mirror/MirrorDaemon.ts";
import * as MirrorGateway from "../host/mirror/MirrorGateway.ts";
import { fileEquals, makeTracker, repoRoot, waitFor } from "./lib/checkKit.mts";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { inertMirrorImpl, rawMirrorSession } from "./lib/mirrorFakes.mts";
import {
  standInDeviceId,
  standInMirror,
  standInPeers,
} from "./lib/hostStandIns.mts";
import { runHost } from "./lib/hostRuntime.mts";
import {
  bootDirectWire,
  DIALER,
  type DirectWire,
  LISTENER,
} from "./lib/directBoot.mts";
import { delay, processAlive } from "./lib/checkKit.mts";

const execFileP = promisify(execFile);
const fileSyncDir = join(repoRoot, "file-sync");

// Sandbox: everything (data dir, repos, the built binary, the
// daemon's data) under one temp tree, with process.env scrubbed and
// the fixture identity set for the commits below (cliSandbox). The
// document-run seam there is what the registered projects need (sm
// projects add).

// A peer's removal announced, as handlers.ts hands it over.
const removal = (deviceId: string, payload: unknown) =>
  runHost(endMirrorsOnPeerRemoval(deviceId, payload));
// The bookkeeping, on the sandbox's engine.
const settleBookkeeping = () => runHost(settleMirrorBookkeeping);

const fixture = cliSandbox("sm-mirror-check-", {
  // The fsevents binding's deprecation warning would otherwise land in
  // the build output on macOS 13+ (see scripts/build-cli.mts).
  CGO_CFLAGS: "-Wno-deprecated-declarations",
});
const { sandbox, smEnv, git, gitOut, addWorktree } = fixture;
const fileSyncBinary = join(sandbox, "file-sync");
const fileSyncDataDir = join(sandbox, "file-sync-data");

const read = (path: string) => readFileSync(path, "utf8");

// Where the gateway listens, once it has bound.
const gatewayAddress = async () => {
  const listening = await gateway.runPromise(
    MirrorGateway.MirrorGateway.use((gw) => gw.listening),
  );
  assert.ok(Option.isSome(listening), "the mirror gateway is not listening");
  return listening.value.address;
};
const gatewayStreams = () =>
  gateway.runSync(MirrorGateway.MirrorGateway.use((gw) => gw.streamCount));

// The pids of the serve children the listener's handler spawned, observed through
// the FileSync service production uses, so "no child spawned" and
// "child gone" are facts about real processes.
const serveChildren = new Set<number>();

// The dialer's daemon and the listener's serve children, on the freshly built binary
// (built in beforeAll).
const fileSync = Layer.effect(
  FileSync.FileSync,
  Effect.gen(function* () {
    const real = yield* FileSync.FileSync;
    return FileSync.FileSync.of({
      ...real,
      serve: (root, dataDir, until) =>
        real
          .serve(root, dataDir, until)
          .pipe(
            Effect.tap((child) =>
              Effect.sync(() => serveChildren.add(child.pid)),
            ),
          ),
    });
  }),
).pipe(Layer.provide(FileSync.layer(() => fileSyncBinary)));

// The dialer's daemon, the way host/process/handlers.ts reads it.
const daemon = {
  status: () => runtime.runSync(MirrorDaemon.onDaemon((d) => d.status)),
  sessions: () => runtime.runSync(MirrorDaemon.onDaemon((d) => d.sessions)),
  create: (input: MirrorCreateInput) =>
    runtime.runPromise(MirrorDaemon.onDaemon((d) => d.create(input))),
  terminate: (id: string) =>
    runtime.runPromise(MirrorDaemon.onDaemon((d) => d.terminate(id))),
  pause: (id: string) =>
    runtime.runPromise(MirrorDaemon.onDaemon((d) => d.pause(id))),
  resume: (id: string) =>
    runtime.runPromise(MirrorDaemon.onDaemon((d) => d.resume(id))),
};

// The dialer's daemon as the mirror impl reads it (host/process/handlers.ts).
const onDaemon = <A,>(
  f: (
    d: MirrorDaemon.MirrorDaemon["Service"],
  ) => Effect.Effect<A, MirrorDaemon.MirrorDaemonError>,
) =>
  Effect.flatMap(
    Effect.suspend(() => runtime.contextEffect),
    (context) =>
      MirrorDaemon.onDaemon(f).pipe(
        Effect.provide(context),
        Effect.mapError((error) => new MirrorError({ reason: error.message })),
      ),
  );
// The impl over the dialer's daemon, the rest of it inert; each check
// below replaces what it is about.
const inertImpl = () =>
  inertMirrorImpl({
    status: Effect.sync(() => daemon.status()),
    sessions: Effect.sync(() => daemon.sessions()),
    create: (input) => onDaemon((d) => d.create(input)),
    terminate: (id) => Effect.asVoid(onDaemon((d) => d.terminate(id))),
    pause: (id) => Effect.asVoid(onDaemon((d) => d.pause(id))),
    resume: (id) => Effect.asVoid(onDaemon((d) => d.resume(id))),
  });

// mirror:stop called the way a caller on this device would, its
// context unread by the handler.
const stop = (input: Parameters<typeof mirrorHandlers.stop>[0]) =>
  runHost(mirrorHandlers.stop(input));

let listenerRepo: string;
let listenerWorktree: string;
let listenerWorktreeId: string;
let dialerRepo: string;
let dialerRoot: string;
let dialerWorktreeId: string;
let listenerProjectId: string;
let dialerProjectId: string;
let stub: DirectWire["stub"];
let listener: DirectWire["listener"];
let toListener: DirectWire["toListener"];
let gateway: ManagedRuntime.ManagedRuntime<MirrorGateway.MirrorGateway, never>;
let runtime: ManagedRuntime.ManagedRuntime<MirrorDaemon.MirrorDaemon, never>;
let createInput: MirrorCreateInput;
let hubBaseline: number;
let session: string;
let servePid: number;
let follower: GitFollower;
let followerScope: Scope.Closeable;
let gitHubBaseline: number;
let listenerTip1: string;
let listenerTip2: string;

const { track, teardown } = makeTracker();

let changes = 0;
// Every daemon snapshot reaches the git follower while it runs, as
// host/process/handlers.ts wires it.
let onSnapshot: (() => void) | null = null;

// The engine status the follower sees, overridable so a mid-cycle
// or halted engine can be posed on demand (G9).
let filesStatus: MirrorSession["status"] | null = null;
const gitStatus = () => follower.statusOf(session);
const stopFollower = () =>
  Effect.runPromise(Scope.close(followerScope, Exit.void));
const waitGit = (status: MirrorGitStatus["status"], what: string) =>
  waitFor(() => gitStatus()?.status === status, what, 30_000);
// Clean for the follower's purposes: nothing staged, nothing
// modified. Untracked files (the mirrored fixture files, node_modules)
// are expected on both sides.
const clean = async (wt: string) =>
  (await gitOut(wt, "status", "--porcelain", "--untracked-files=no")) === "";

beforeAll(async () => {
  // ---- Fixtures: build the CLI, seed the listener's repo and worktree, the dialer's dir ----
  await Promise.all([
    fixture.buildSm(),
    execFileP("go", ["build", "-o", fileSyncBinary, "."], {
      cwd: fileSyncDir,
      env: smEnv,
    }),
  ]);

  listenerRepo = await fixture.initRepo("listener-repo");
  await fixture.commitFile(listenerRepo, "readme.txt", "base\n", "base");
  listenerWorktree = await addWorktree(listenerRepo, "listener-wt", "feature");
  // The content that must cross on the first cycle: a tracked file, a
  // nested one, a gitignored-looking one. And the .git POINTER FILE of
  // a linked worktree, which must never cross.
  writeFileSync(join(listenerWorktree, "src.txt"), "from the listener\n");
  mkdirSync(join(listenerWorktree, "deep", "er"), { recursive: true });
  writeFileSync(join(listenerWorktree, "deep", "er", "leaf.txt"), "leaf\n");
  writeFileSync(join(listenerWorktree, ".env"), "SECRET=1\n");
  assert.ok(
    existsSync(join(listenerWorktree, ".git")) &&
      read(join(listenerWorktree, ".git")).startsWith("gitdir:"),
    "fixture: the linked worktree's .git is a pointer file",
  );
  listenerWorktreeId = worktreeIdFromPath(listenerWorktree);

  // The dialer's side is a REAL worktree of a clone of the listener's repository, on the
  // same branch at the same tip: the state a mirror start leaves behind
  // (the original here on the dialer, which runs the session, the copy on the listener),
  // and what the git follower needs to have something to follow.
  dialerRepo = await fixture.cloneRepo(listenerRepo, "dialer-repo");
  dialerRoot = join(sandbox, "dialer-wt");
  await git(dialerRepo, [
    "worktree",
    "add",
    "-q",
    "-b",
    "feature",
    dialerRoot,
    "origin/feature",
  ]);
  writeFileSync(join(dialerRoot, "from-b.txt"), "from the dialer\n");
  dialerWorktreeId = worktreeIdFromPath(dialerRoot);

  await fixture.useCli();
  listenerProjectId = await fixture.projectIdOf(listenerRepo);
  dialerProjectId = await fixture.projectIdOf(dialerRepo);

  // ---- The direct wire: the listener serves the byte wire and its worktree list,
  // the dialer dials through the real bridge cache. ----
  ({ stub, listener, toListener } = await bootDirectWire(track, {
    provide: fileSync.pipe(Layer.provide(NodeServices.layer)),
    contracts: [
      [forwardContract, forwardHandlers],
      [worktreesContract, worktreesHandlers],
      // The git follower's peer half: the transfer verbs (both
      // directions) and the mirror's git state pair.
      [syncContract, syncHandlers],
      [mirrorContract, mirrorHandlers],
    ],
  }));
  // Every peer reach of the dialer's host code (the follower's sync and mirror
  // calls, its source links) rides the same session.
  standInPeers({
    transportFor: () => toListener.transport,
    channelsFor: () => toListener.channels,
  });
  standInDeviceId(DIALER);

  // The dialer's half: the real gateway over the real peer client, the real
  // daemon on the freshly built binary.
  gateway = ManagedRuntime.make(
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
});

afterAll(async () => {
  await teardown();
  await fixture.remove();
});

it("gateway bound and the real mirror daemon reported ready", async () => {
  assert.match(await gatewayAddress(), /^127\.0\.0\.1:\d+$/);
  runtime = ManagedRuntime.make(
    MirrorDaemon.layer({ dataDir: () => fileSyncDataDir }).pipe(
      Layer.provideMerge(fileSync),
      Layer.provide(Layer.succeedContext(await gateway.context())),
      Layer.provide(NodeServices.layer),
    ),
  );
  track(() => runtime.dispose());
  runtime.runFork(
    MirrorDaemon.MirrorDaemon.use((d) =>
      Stream.runForEach(d.changes, () =>
        Effect.sync(() => {
          changes++;
          onSnapshot?.();
        }),
      ),
    ),
  );
  await waitFor(
    () => daemon.status() === "running",
    "the daemon to report ready",
    30_000,
  );
});

it("gateway refuses a local process that cannot present its token", async () => {
  // The loopback port is reachable by every process on this machine,
  // so the preface token is what separates our own daemon from one
  // that merely found the port and would otherwise drive file
  // transfers against peer devices.
  const [host, port] = (await gatewayAddress()).split(":");
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = netConnect(Number(port), host, () => {
      socket.write(
        `${JSON.stringify({
          deviceId: LISTENER,
          projectId: "p",
          worktreeId: "0123456789ab",
        })}\n`,
      );
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
  });
  assert.match(
    answer,
    /^error /,
    "an untokened local process opened a mirror stream",
  );
  assert.equal(
    gatewayStreams(),
    0,
    "the refused connection was bridged anyway",
  );
});

it("ungranted peer: create fails with the grant refusal and the listener spawns nothing", async () => {
  createInput = {
    localRoot: dialerRoot,
    deviceId: LISTENER,
    projectId: listenerProjectId,
    worktreeId: listenerWorktreeId,
    remoteRoot: listenerWorktree,
    name: "feature",
    localWorktreeId: dialerWorktreeId,
    labels: { localProjectId: dialerProjectId },
    // A build folder held back by the create's own ignores.
    ignores: ["/dist"],
  };

  // (1) Ungranted: the gateway's openStream is refused on the listener's wire, so
  // the daemon's connect fails and create rejects with that reason.
  // No serve child was ever spawned.
  await assert.rejects(
    () => daemon.create(createInput),
    (error: unknown) =>
      /not permitted to run commands/.test(errorMessageOf(error)),
  );
  assert.equal(
    serveChildren.size,
    0,
    "an ungranted open spawned a serve child",
  );
  assert.deepEqual(listMirrorServing(), []);
});

it("granted create: seeded files converge both ways, .git pointer held back", async () => {
  listener.setAccepts(true);

  // (2) Granted: the session comes up, seeded content crosses both
  // ways on the first cycle, the .git pointer stays on the listener.
  hubBaseline = stub.forwardedCount();
  session = await daemon.create(createInput);
  assert.match(session, /^sync_/);
  await waitFor(
    () =>
      fileEquals(join(dialerRoot, "src.txt"), "from the listener\n") &&
      fileEquals(join(dialerRoot, "deep", "er", "leaf.txt"), "leaf\n") &&
      fileEquals(join(dialerRoot, ".env"), "SECRET=1\n") &&
      fileEquals(join(listenerWorktree, "from-b.txt"), "from the dialer\n"),
    "the seeded content to converge both ways",
    60_000,
  );
  // Each side keeps its OWN .git pointer: the listener's names listener-repo's gitdir,
  // the dialer's names dialer-repo's, and neither crossed.
  assert.match(
    read(join(dialerRoot, ".git")),
    /dialer-repo/,
    "the dialer's .git pointer was overwritten",
  );
  assert.match(
    read(join(listenerWorktree, ".git")),
    /listener-repo/,
    "the listener's .git pointer was overwritten",
  );
});

it("the listener serves exactly one stream, attributed to worktree and caller", async () => {
  // (3) The serving list on the listener names the worktree and the caller, and
  // exactly one serve child is alive.
  await waitFor(
    () => listMirrorServing().length === 1,
    "A to list one served mirror stream",
  );
  const [served] = listMirrorServing();
  assert.ok(served !== undefined, "the listener lists no served mirror stream");
  assert.equal(served.projectId, listenerProjectId);
  assert.equal(served.worktreeId, listenerWorktreeId);
  assert.equal(served.peerDeviceId, DIALER);
  // The preface carried the dialer's own worktree id for the pair.
  assert.equal(served.peerWorktreeId, dialerWorktreeId);
  assert.equal(serveChildren.size, 1);
  const [pid] = serveChildren;
  assert.ok(
    pid !== undefined && processAlive(pid),
    "the serve child is not running",
  );
  servePid = pid;
});

it("live edits cross both ways, deletes propagate, the device hub stays flat", async () => {
  // (4) Live edits both ways, a delete, a nested create. The hub stays
  // flat throughout.
  writeFileSync(
    join(listenerWorktree, "src.txt"),
    "from the listener, edited\n",
  );
  await waitFor(
    () =>
      fileEquals(join(dialerRoot, "src.txt"), "from the listener, edited\n"),
    "the listener's edit to reach the dialer",
    30_000,
  );
  mkdirSync(join(dialerRoot, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dialerRoot, "node_modules", "dep", "index.js"), "1\n");
  await waitFor(
    () =>
      fileEquals(
        join(listenerWorktree, "node_modules", "dep", "index.js"),
        "1\n",
      ),
    "the dialer's nested write to reach the listener",
    30_000,
  );
  rmSync(join(listenerWorktree, ".env"));
  await waitFor(
    () => !existsSync(join(dialerRoot, ".env")),
    "the listener's delete to reach the dialer",
    30_000,
  );
  assert.equal(
    stub.forwardedCount(),
    hubBaseline,
    "the mirror stream rode the device hub instead of the direct socket",
  );
});

it("the state stream reports watching, both endpoints connected, cycles counted", async () => {
  // (5) The daemon's state stream describes the session in the app's
  // vocabulary.
  await waitFor(() => {
    const state = daemon.sessions().find((s) => s.session === session);
    return state !== undefined && state.status === "watching";
  }, "a watching snapshot");
  const state = daemon.sessions().find((s) => s.session === session);
  assert.ok(state, "the watching session left the state stream");
  assert.equal(state.deviceId, LISTENER);
  assert.equal(state.projectId, listenerProjectId);
  assert.equal(state.worktreeId, listenerWorktreeId);
  assert.equal(state.localRoot, dialerRoot);
  assert.equal(state.remoteRoot, listenerWorktree);
  assert.equal(state.localWorktreeId, dialerWorktreeId);
  assert.equal(state.local.connected, true);
  assert.equal(state.remote.connected, true);
  assert.ok(state.successfulCycles >= 1);
  assert.deepEqual(state.conflicts, []);
  assert.deepEqual(state.ignores, ["/dist"]);
  assert.ok(state.createdAt > 0, "the session carries no creation time");
  assert.ok(changes > 0, "the daemon never signalled a change");
});

it("the create's ignores hold: /dist stays on the listener while its sibling crosses", async () => {
  // The ignore held: a file under it on the listener never reached the dialer while the
  // sibling beside it did.
  mkdirSync(join(listenerWorktree, "dist"), { recursive: true });
  writeFileSync(join(listenerWorktree, "dist", "bundle.js"), "built\n");
  writeFileSync(join(listenerWorktree, "beside-dist.txt"), "crosses\n");
  await waitFor(
    () => fileEquals(join(dialerRoot, "beside-dist.txt"), "crosses\n"),
    "the sibling of the ignored folder to reach the dialer",
    30_000,
  );
  assert.ok(
    !existsSync(join(dialerRoot, "dist", "bundle.js")),
    "an ignored path crossed to the dialer",
  );
});

it("git: a fresh session on equal tips reports synced", async () => {
  // ---- The git follower, against the same wire ----
  gitHubBaseline = stub.forwardedCount();
  // (G1) Both sides agree from the start.
  followerScope = Effect.runSync(Scope.make());
  track(stopFollower);
  follower = await runHost(
    makeGitFollower({
      sessions: Effect.sync(() => {
        const sessions = daemon.sessions();
        if (filesStatus === null) return sessions;
        const status = filesStatus;
        return sessions.map((s) => Object.assign({}, s, { status }));
      }),
      sweepMs: 60_000,
      log: (message) => console.log(message),
    }).pipe(Scope.provide(followerScope)),
  );
  onSnapshot = () => follower.sessionsChanged();
  await waitGit("synced", "the follower to report synced");
});

it("git: a commit on the listener lands on the dialer with the same tip, branch and a clean status", async () => {
  // (G2) A commit on the listener lands on the dialer: tip, branch and a clean status.
  writeFileSync(
    join(listenerWorktree, "readme.txt"),
    "base, edited on the listener\n",
  );
  await waitFor(
    () =>
      fileEquals(
        join(dialerRoot, "readme.txt"),
        "base, edited on the listener\n",
      ),
    "the edit to mirror before the commit",
    30_000,
  );
  await git(listenerWorktree, ["add", "readme.txt"]);
  await git(listenerWorktree, ["commit", "-qm", "on the listener"]);
  listenerTip1 = await gitOut(listenerWorktree, "rev-parse", "HEAD");
  // What the listener's git-directory watcher would push in production.
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitFor(
    async () =>
      (await gitOut(dialerRoot, "rev-parse", "HEAD")) === listenerTip1,
    "the dialer's tip to follow the listener's commit",
    30_000,
  );
  assert.equal(
    await gitOut(dialerRoot, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
  await waitFor(
    () => clean(dialerRoot),
    "the dialer to read clean after the follow",
    30_000,
  );
  await waitGit("synced", "synced after the listener's commit");
});

it("git: a file staged on the listener is staged on the dialer, with the working tree untouched", async () => {
  // (G3) Staging on the listener shows as staged on the dialer, files untouched.
  await git(listenerWorktree, ["add", "src.txt"]);
  // What the listener's served-index watcher would push in production.
  follower.onPeerWorktreeChanged(
    LISTENER,
    listenerProjectId,
    listenerWorktreeId,
  );
  await waitFor(
    async () =>
      (await gitOut(dialerRoot, "diff", "--cached", "--name-only")) ===
      "src.txt",
    "src.txt to show as staged on the dialer",
    30_000,
  );
  assert.equal(
    read(join(dialerRoot, "src.txt")),
    "from the listener, edited\n",
  );
  await waitGit("synced", "synced after the listener's stage");
});

it("git: a commit on the dialer lands on the listener with the same tip and a clean status", async () => {
  // (G4) A commit on the dialer lands on the listener (the push direction).
  await git(dialerRoot, ["commit", "-qm", "on the dialer"]);
  const dialerTip1 = await gitOut(dialerRoot, "rev-parse", "HEAD");
  assert.notEqual(dialerTip1, listenerTip1);
  // The dialer's own index watcher fires on the commit. The project ping is
  // what the local git-directory watcher would add.
  follower.onLocalProjectChanged(dialerProjectId);
  await waitFor(
    async () =>
      (await gitOut(listenerWorktree, "rev-parse", "HEAD")) === dialerTip1,
    "the listener's tip to follow the dialer's commit",
    30_000,
  );
  await waitFor(
    () => clean(listenerWorktree),
    "A to read clean after the follow",
    30_000,
  );
  await waitGit("synced", "synced after the dialer's commit");
});

it("git: commits on both sides report diverged and move nothing", async () => {
  // (G5) Commits on both sides since they agreed: diverged, nothing
  // moves, and resolving on the dialer restores sync.
  writeFileSync(join(listenerWorktree, "a-only.txt"), "a\n");
  await waitFor(
    () => fileEquals(join(dialerRoot, "a-only.txt"), "a\n"),
    "a-only.txt to mirror",
    30_000,
  );
  await git(listenerWorktree, ["add", "a-only.txt"]);
  await git(listenerWorktree, ["commit", "-qm", "diverge on the listener"]);
  listenerTip2 = await gitOut(listenerWorktree, "rev-parse", "HEAD");
  writeFileSync(join(dialerRoot, "b-only.txt"), "b\n");
  await waitFor(
    () => fileEquals(join(listenerWorktree, "b-only.txt"), "b\n"),
    "b-only.txt to mirror",
    30_000,
  );
  await git(dialerRoot, ["add", "b-only.txt"]);
  await git(dialerRoot, ["commit", "-qm", "diverge on the dialer"]);
  const dialerTip2 = await gitOut(dialerRoot, "rev-parse", "HEAD");
  follower.onLocalProjectChanged(dialerProjectId);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("diverged", "the follower to report diverged");
  assert.match(gitStatus()?.detail ?? "", /both sides have new commits/);
  assert.equal(
    await gitOut(listenerWorktree, "rev-parse", "HEAD"),
    listenerTip2,
  );
  assert.equal(await gitOut(dialerRoot, "rev-parse", "HEAD"), dialerTip2);
});

it("git: dropping one side's commit lets the other side land again", async () => {
  // Resolve on the dialer by dropping its own commit: the dialer is back at the tip
  // both sides last agreed on, so only the listener has moved and the follower
  // carries the listener's commit over. (The reset also removes b-only.txt from
  // the dialer's tree, and the engine mirrors that removal to the listener, where it was
  // never committed.)
  await git(dialerRoot, ["reset", "-q", "--hard", "HEAD~1"]);
  // The staged b-only.txt is gone from the index but the file stays
  // (the engine mirrors it), which is the ordinary dirty case.
  follower.onLocalProjectChanged(dialerProjectId);
  await waitFor(
    async () =>
      (await gitOut(dialerRoot, "rev-parse", "HEAD")) === listenerTip2,
    "the dialer to follow the listener once its own commit is dropped",
    30_000,
  );
  await waitGit("synced", "synced after resolving the divergence");
});

it("git: a checkout on the listener to a branch held by another worktree on the dialer is refused with the path", async () => {
  // (G6) A branch collision: A checks out a branch that another
  // worktree on the dialer already holds. Refused with the path, nothing
  // moves. Checking back on the listener restores sync.
  await addWorktree(dialerRepo, "dialer-wt2", "other");
  await git(listenerWorktree, ["checkout", "-q", "-b", "other"]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("blocked", "the follower to report blocked");
  assert.match(gitStatus()?.detail ?? "", /branch other is checked out at/);
  assert.equal(
    await gitOut(dialerRoot, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
});

it("git: checking back on the listener restores sync, with the device hub still flat", async () => {
  await git(listenerWorktree, ["checkout", "-q", "feature"]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("synced", "synced after the listener checks back");
  assert.equal(
    stub.forwardedCount(),
    gitHubBaseline,
    "the git follower rode the device hub instead of the direct socket",
  );
});

it("git: a merge on the listener or a rebase on the dialer reports blocked with the side named, moves nothing, and finishing it resumes the follow", async () => {
  // (G7) A git operation in progress on either side blocks the
  // follow, naming the side, and nothing moves until it finishes.
  // A merge stopped before its commit on the listener (a no-ff merge of a commit
  // with the same tree, so no file changes):
  const sideTip = await gitOut(
    listenerWorktree,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "side",
  );
  await git(listenerWorktree, ["update-ref", "refs/heads/side-op", sideTip]);
  const tipBeforeOps = await gitOut(dialerRoot, "rev-parse", "HEAD");
  await git(listenerWorktree, [
    "merge",
    "-q",
    "--no-ff",
    "--no-commit",
    "side-op",
  ]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("blocked", "the follower to report the listener's merge");
  assert.match(
    gitStatus()?.detail ?? "",
    /a merge is in progress on the other device/,
  );
  assert.equal(await gitOut(dialerRoot, "rev-parse", "HEAD"), tipBeforeOps);
  await git(listenerWorktree, ["commit", "-qm", "merge side-op"]);
  const mergeTip = await gitOut(listenerWorktree, "rev-parse", "HEAD");
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitFor(
    async () => (await gitOut(dialerRoot, "rev-parse", "HEAD")) === mergeTip,
    "the dialer to follow the listener's finished merge",
    30_000,
  );
  await waitGit("synced", "synced after the listener's merge finished");
  // A rebase stopped on the dialer (an exec that fails leaves it mid-way, on a
  // detached HEAD), which must not reach the listener as a detached HEAD:
  await assert.rejects(() =>
    git(dialerRoot, ["rebase", "--exec", "false", "HEAD~1"]),
  );
  follower.onLocalProjectChanged(dialerProjectId);
  await waitGit("blocked", "the follower to report the dialer's rebase");
  assert.match(gitStatus()?.detail ?? "", /a rebase is in progress here/);
  assert.equal(
    await gitOut(listenerWorktree, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
  await git(dialerRoot, ["rebase", "--abort"]);
  follower.onLocalProjectChanged(dialerProjectId);
  await waitGit("synced", "synced after the dialer's rebase was aborted");
});

it("git: a half-landed apply heals to synced instead of reading diverged", async () => {
  // (G8) A half-landed apply heals: the dialer's branch already at the listener's new
  // tip (as if read-tree failed on a held index lock after the ref
  // moved), its index still the old tree. Both tips moved since the
  // agreement, yet the two share one now, so only the indexes count.
  writeFileSync(join(listenerWorktree, "half.txt"), "half\n");
  await waitFor(
    () => fileEquals(join(dialerRoot, "half.txt"), "half\n"),
    "half.txt to mirror",
    30_000,
  );
  await git(listenerWorktree, ["add", "half.txt"]);
  await git(listenerWorktree, ["commit", "-qm", "half-applied on the dialer"]);
  const halfTip = await gitOut(listenerWorktree, "rev-parse", "HEAD");
  await git(dialerRepo, ["fetch", "-q", listenerRepo, "feature"]);
  await git(dialerRoot, ["update-ref", "refs/heads/feature", halfTip]);
  assert.notEqual(
    await gitOut(dialerRoot, "diff", "--cached", "--name-only"),
    "",
  );
  follower.onLocalProjectChanged(dialerProjectId);
  await waitFor(
    async () =>
      (await gitOut(dialerRoot, "diff", "--cached", "--name-only")) === "",
    "the dialer's index to heal to the listener's",
    30_000,
  );
  await waitGit("synced", "synced after the half-landed apply healed");
  assert.ok(await clean(dialerRoot), "the dialer is not clean after the heal");
});

it("git: a commit waits for the files (staging does not), a halted engine reads blocked, and the idle snapshot releases it", async () => {
  // (G9) Git follows the files: a commit waits while the engine is
  // mid-cycle, staging does not, a halted engine reads blocked, and
  // the idle snapshot releases the wait.
  writeFileSync(join(listenerWorktree, "wait.txt"), "wait\n");
  await waitFor(
    () => fileEquals(join(dialerRoot, "wait.txt"), "wait\n"),
    "wait.txt to mirror",
    30_000,
  );
  const tipBeforeWait = await gitOut(dialerRoot, "rev-parse", "HEAD");
  filesStatus = "staging-remote";
  await git(listenerWorktree, ["add", "wait.txt"]);
  follower.onPeerWorktreeChanged(
    LISTENER,
    listenerProjectId,
    listenerWorktreeId,
  );
  await waitFor(
    async () =>
      (await gitOut(dialerRoot, "diff", "--cached", "--name-only")) ===
      "wait.txt",
    "staging to cross while the files are mid-cycle",
    30_000,
  );
  await git(listenerWorktree, ["commit", "-qm", "wait for files"]);
  const waitTip = await gitOut(listenerWorktree, "rev-parse", "HEAD");
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitFor(
    () => gitStatus()?.detail === "waiting for files to catch up",
    "the commit to wait for the files",
    30_000,
  );
  assert.equal(gitStatus()?.status, "following");
  assert.equal(await gitOut(dialerRoot, "rev-parse", "HEAD"), tipBeforeWait);
  filesStatus = "halted-on-root-deletion";
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("blocked", "a halted engine to read blocked");
  assert.match(gitStatus()?.detail ?? "", /file sync has halted/);
  assert.equal(await gitOut(dialerRoot, "rev-parse", "HEAD"), tipBeforeWait);
  filesStatus = null;
  // The engine's idle snapshot, as the daemon would send it.
  follower.sessionsChanged();
  await waitFor(
    async () => (await gitOut(dialerRoot, "rev-parse", "HEAD")) === waitTip,
    "the dialer to follow once the files are idle",
    30_000,
  );
  await waitGit("synced", "synced after the files caught up");
});

it("git: a primary mirrored to a mirror/main worktree carries commits both ways with the copy's own main untouched, and a stray branch on the copy is reported rather than followed", async () => {
  // (G10) A primary checkout's mirror: the dialer's repo itself, the
  // original on the device running the session, mirrored to the listener as a
  // worktree on mirror/main (the session's mirrorBranch label),
  // beside the listener's own primary on main. The follower reads the two names
  // as one: a commit on the dialer's main lands on the listener's mirror/main, one there
  // lands on the dialer's main, and the listener's own main never moves.
  const listenerRoot2 = join(sandbox, "wt-a-mirror");
  await git(listenerRepo, [
    "worktree",
    "add",
    "-q",
    "-b",
    "mirror/main",
    listenerRoot2,
    "main",
  ]);
  const listenerWorktreeId2 = worktreeIdFromPath(listenerRoot2);
  const dialerPrimaryId = worktreeIdFromPath(dialerRepo);
  const mainBefore = await gitOut(listenerRepo, "rev-parse", "HEAD");
  const session2 = await daemon.create({
    localRoot: dialerRepo,
    deviceId: LISTENER,
    projectId: listenerProjectId,
    worktreeId: listenerWorktreeId2,
    remoteRoot: listenerRoot2,
    name: "main",
    localWorktreeId: dialerPrimaryId,
    labels: {
      localProjectId: dialerProjectId,
      [MIRROR_LABEL_MODE]: "mirror-branch",
    },
    ignores: [],
  });
  // The daemon's snapshot names the session a moment after the
  // create answers. In the app every snapshot pokes the follower;
  // here the poke is by hand once the session is on the list.
  await waitFor(
    () => daemon.sessions().some((s) => s.session === session2),
    "the primary's session to reach the state stream",
  );
  follower.sessionsChanged();
  const waitGit2 = (status: MirrorGitStatus["status"], what: string) =>
    waitFor(() => follower.statusOf(session2)?.status === status, what, 30_000);
  await waitGit2("synced", "the primary's mirror to report synced");
  writeFileSync(join(dialerRepo, "primary-b.txt"), "b\n");
  await waitFor(
    () => fileEquals(join(listenerRoot2, "primary-b.txt"), "b\n"),
    "primary-b.txt to mirror",
    30_000,
  );
  await git(dialerRepo, ["add", "primary-b.txt"]);
  await git(dialerRepo, ["commit", "-qm", "on the dialer's primary"]);
  const dialerTip3 = await gitOut(dialerRepo, "rev-parse", "HEAD");
  follower.onLocalProjectChanged(dialerProjectId);
  await waitFor(
    async () =>
      (await gitOut(listenerRoot2, "rev-parse", "HEAD")) === dialerTip3,
    "the listener's mirror/main to follow the dialer's primary",
    30_000,
  );
  assert.equal(
    await gitOut(listenerRoot2, "symbolic-ref", "HEAD"),
    "refs/heads/mirror/main",
  );
  await waitGit2("synced", "synced after the dialer's primary committed");
  writeFileSync(join(listenerRoot2, "primary-a.txt"), "a\n");
  await waitFor(
    () => fileEquals(join(dialerRepo, "primary-a.txt"), "a\n"),
    "primary-a.txt to mirror",
    30_000,
  );
  await git(listenerRoot2, ["add", "primary-a.txt"]);
  await git(listenerRoot2, ["commit", "-qm", "on the listener's mirror/main"]);
  const listenerTip3 = await gitOut(listenerRoot2, "rev-parse", "HEAD");
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitFor(
    async () =>
      (await gitOut(dialerRepo, "rev-parse", "HEAD")) === listenerTip3,
    "the dialer's primary to follow the listener's mirror/main",
    30_000,
  );
  assert.equal(
    await gitOut(dialerRepo, "symbolic-ref", "HEAD"),
    "refs/heads/main",
  );
  await waitGit2("synced", "synced after the listener's mirror/main committed");
  assert.equal(
    await gitOut(listenerRepo, "rev-parse", "HEAD"),
    mainBefore,
    "the listener's own primary must not move",
  );
  // The copy leaving the mirror/ rule is reported, not followed: the dialer's
  // primary stays on main until the copy is back on a mirror/ branch.
  await git(listenerRoot2, ["checkout", "-q", "-b", "stray"]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit2("blocked", "the follower to report the stray branch");
  assert.match(
    follower.statusOf(session2)?.detail ?? "",
    /without the mirror\//,
  );
  assert.equal(
    await gitOut(dialerRepo, "symbolic-ref", "HEAD"),
    "refs/heads/main",
  );
  await git(listenerRoot2, ["checkout", "-q", "mirror/main"]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit2("synced", "synced once the copy is back on mirror/main");
  await daemon.terminate(session2);
  await waitFor(
    () => daemon.sessions().every((s) => s.session !== session2),
    "the primary's session to leave the state stream",
  );
});

it("terminate drops the stream, ends the serve child, leaves both copies intact", async () => {
  onSnapshot = null;
  await stopFollower();

  // (6) Terminate: the session is gone, the listener's stream dropped, the serve
  // child exited, and the files stay put on both sides.
  await daemon.terminate(session);
  await waitFor(
    () => daemon.sessions().every((s) => s.session !== session),
    "the session to leave the state stream",
  );
  await waitFor(
    () => listMirrorServing().length === 0,
    "the listener's serving list to empty",
    15_000,
  );
  await waitFor(
    () => !processAlive(servePid),
    "the serve child to exit",
    15_000,
  );
  assert.equal(
    read(join(dialerRoot, "src.txt")),
    "from the listener, edited\n",
  );
  assert.equal(read(join(listenerWorktree, "from-b.txt")), "from the dialer\n");
});

it("one-shot transfer: the admitted file crosses, the rule holds, nothing flows back, the session ends itself", async () => {
  // (6b) A transplant's files step (host/mirror/oneShot.ts): the same
  // daemon run once with the leave-out rule's patterns, settled on
  // its first cycle and ended by itself. A path under the rule stays
  // on the listener, one beside it crosses, and no session survives the call.
  // Only the daemon slot's create/sessions/terminate/status are in
  // play. The rest of the impl is inert here.
  standInMirror(inertImpl());
  mkdirSync(join(listenerWorktree, "skip"), { recursive: true });
  writeFileSync(join(listenerWorktree, "skip", "me.txt"), "stays\n");
  writeFileSync(join(listenerWorktree, "once.txt"), "once\n");
  // Only on the dialer: a pull is one way, so it must never reach the listener.
  writeFileSync(join(dialerRoot, "local-only.txt"), "mine\n");
  const once = await runHost(
    transferFilesOnce(
      {
        localRoot: dialerRoot,
        localWorktreeId: dialerWorktreeId,
        sourceDeviceId: LISTENER,
        sourceProjectId: listenerProjectId,
        sourceWorktreeId: listenerWorktreeId,
        remoteRoot: listenerWorktree,
        name: "feature",
        ignores: ["/skip"],
      },
      () => {},
    ),
  );
  assert.deepEqual(once, { crossed: true, conflicts: 0 });
  assert.equal(read(join(dialerRoot, "once.txt")), "once\n");
  assert.equal(
    existsSync(join(dialerRoot, "skip")),
    false,
    "a path under the transfer's rule crossed",
  );
  assert.equal(
    existsSync(join(listenerWorktree, "local-only.txt")),
    false,
    "a pull pushed the dialer's own file onto the listener",
  );
  await waitFor(
    () => daemon.sessions().length === 0,
    "the one-shot session to be gone",
  );
  await waitFor(
    () => listMirrorServing().length === 0,
    "the listener's serving list to empty after the one-shot",
    15_000,
  );
});

it("replica pass: the copy takes the original's version of a clash, loses what only it held, keeps what the rule leaves out", async () => {
  // (6b') A mirror start's first pass (mirror:startTo): the copy (the listener)
  // made an exact copy of the original (the dialer) before the two-way session
  // opens. A path both hold differently (what a carry-over or a setup
  // script wrote on the copy) takes the original's version instead of
  // standing as a conflict, what only the copy holds goes, and a path
  // under the rule is left alone on the copy.
  writeFileSync(join(dialerRoot, "clash.txt"), "the original's\n");
  writeFileSync(join(listenerWorktree, "clash.txt"), "the copy's create\n");
  writeFileSync(join(listenerWorktree, "stray.txt"), "only on the copy\n");
  const replica = await runHost(
    transferFilesOnce(
      {
        localRoot: dialerRoot,
        localWorktreeId: dialerWorktreeId,
        sourceDeviceId: LISTENER,
        sourceProjectId: listenerProjectId,
        sourceWorktreeId: listenerWorktreeId,
        remoteRoot: listenerWorktree,
        name: "feature",
        ignores: ["/skip"],
        direction: "replica",
      },
      () => {},
    ),
  );
  assert.deepEqual(replica, { crossed: true, conflicts: 0 });
  assert.equal(read(join(listenerWorktree, "clash.txt")), "the original's\n");
  assert.equal(read(join(dialerRoot, "clash.txt")), "the original's\n");
  assert.equal(existsSync(join(listenerWorktree, "stray.txt")), false);
  assert.equal(read(join(listenerWorktree, "skip", "me.txt")), "stays\n");
  await waitFor(
    () => daemon.sessions().length === 0,
    "the replica session to be gone",
  );
});

it("a device leaving the account ends the mirrors with it, copies kept, transfers untouched", async () => {
  // (6c) A device leaving the account ends the mirrors it had with
  // it, copies kept (host/mirror/registry.ts endMirrorsWithPeers):
  // this device signing out ends every mirror, a peer removed from
  // the registry ends only the mirrors with that peer, a transfer
  // session is not a mirror and stays, and every ended mirror's
  // worktree thread hears why. A fake daemon, since the rule is
  // about which sessions are picked, not the engine.
  {
    const live = new Map([
      [
        "s-with-a",
        rawMirrorSession({
          session: "s-with-a",
          deviceId: LISTENER,
          localWorktreeId: "listener-wt",
          labels: {
            [MIRROR_LABEL_MODE]: "mirror",
          },
        }),
      ],
      [
        "s-with-c",
        rawMirrorSession({
          session: "s-with-c",
          deviceId: "C",
          localWorktreeId: "wt-c",
          labels: {
            [MIRROR_LABEL_MODE]: "mirror",
          },
        }),
      ],
      [
        "t-with-a",
        rawMirrorSession({
          session: "t-with-a",
          deviceId: LISTENER,
          labels: { [MIRROR_LABEL_MODE]: "transfer-token" },
        }),
      ],
    ]);
    const noted: Parameters<MirrorEngine["Service"]["noteEvent"]>[] = [];
    standInMirror({
      ...inertImpl(),
      sessions: Effect.sync(() => [...live.values()]),
      terminate: (id) =>
        Effect.sync(() => {
          live.delete(id);
        }),
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
    });
    await runHost(
      endMirrorsWithPeers(
        (deviceId) => deviceId !== LISTENER,
        "the listener left",
      ),
    );
    assert.deepEqual([...live.keys()], ["s-with-c", "t-with-a"]);
    assert.deepEqual(noted, [["listener-wt", "stopped", "the listener left"]]);
    await runHost(endMirrorsWithPeers(() => false, "signed out"));
    assert.deepEqual([...live.keys()], ["t-with-a"]);
    assert.deepEqual(noted.at(-1), ["wt-c", "stopped", "signed out"]);
  }
});

// A mirror of `original` into the copy `worktreeId` on `deviceId`.
const into = (
  id: string,
  deviceId: string,
  worktreeId: string,
  original: string,
) =>
  rawMirrorSession({
    session: id,
    deviceId,
    projectId: "p",
    worktreeId,
    localWorktreeId: original,
    labels: {
      [MIRROR_LABEL_MODE]: "mirror",
    },
  });

it("a peer's removed worktree ends only the mirrors into that copy, nothing deleted", async () => {
  // (6e) A copy deleted on its own device: that device announces
  // the removal (worktrees:removal) and this one, which runs the
  // session, ends it once the removal is done. Only the sessions into
  // the announced copy end, each original's thread says why, and
  // nothing is deleted. Another device's worktree of the same id
  // stays.
  {
    const live = new Map(
      [
        into("s-into-a", LISTENER, "wt-copy", "wt-original"),
        into("s-into-a-other", LISTENER, "wt-other", "wt-original-2"),
        into("s-into-c", "C", "wt-copy", "wt-original-3"),
      ].map((raw): [string, MirrorSessionRaw] => [raw.session, raw]),
    );
    const noted: Parameters<MirrorEngine["Service"]["noteEvent"]>[] = [];
    standInMirror({
      ...inertImpl(),
      status: Effect.succeed("running"),
      sessions: Effect.sync(() => [...live.values()]),
      terminate: (id) =>
        Effect.sync(() => {
          live.delete(id);
        }),
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
    });
    const copy = { projectId: "p", worktreeId: "wt-copy" };
    await removal(LISTENER, { ...copy, state: "removing" });
    await removal(LISTENER, { ...copy, state: "kept" });
    assert.equal(live.size, 3, "a removal not yet done ended a mirror");
    await removal(LISTENER, { ...copy, state: "removed" });
    assert.deepEqual([...live.keys()], ["s-into-a-other", "s-into-c"]);
    assert.deepEqual(noted, [["wt-original", "stopped", COPY_GONE_DETAIL]]);
    // Announced twice (the stop's own end, then the announcement), it
    // ends nothing more.
    await removal(LISTENER, { ...copy, state: "removed" });
    assert.equal(noted.length, 1);
  }
});

it("a moved worktree re-opens only its own mirrors, on the new path under the new id", async () => {
  // A worktree here re-keyed by a move (host/lib/worktrees/moving.ts):
  // each session on it re-opens at the new path, and the new session
  // runs on the new id, which the engine echoes back from then on.
  const live = [
    into("s-moved", LISTENER, "wt-copy", "wt-old"),
    into("s-other", LISTENER, "wt-copy-2", "wt-kept"),
  ];
  const reopened: [string, MirrorCreateInput][] = [];
  standInMirror({
    ...inertImpl(),
    status: Effect.succeed("running"),
    sessions: Effect.sync(() => live),
    recreate: (id, input) =>
      Effect.sync(() => {
        reopened.push([id, input]);
        return `${id}-again`;
      }),
  });
  await runHost(
    moveMirrorsOfWorktree("wt-old", { id: "wt-new", path: "/moved/here" }),
  );
  assert.deepEqual(
    reopened.map(([id, input]) => [
      id,
      input.localRoot,
      input.localWorktreeId,
      input.worktreeId,
    ]),
    [["s-moved", "/moved/here", "wt-new", "wt-copy"]],
  );
});

it("stop: a conflict or git not in step refuses removing the copy unforced, an original gone never takes its copy and says so, a root that went under a seen session ends it the same way whatever the engine calls it, and leftovers and delayed stops are swept, sparing a running re-open, a held root and a root on a volume not mounted, and retrying a failed end", async () => {
  // (6e) The stop's safety and its keep-the-copy, the original gone
  // behind the app's back, a re-open's leftover, and a stop that
  // came while the daemon was down. Against a recording daemon and
  // a recording peer: what is pinned is which session ends, what the
  // peer is asked, and what the thread says.
  {
    const settled: Partial<MirrorSessionRaw> = {
      status: "watching",
      successfulCycles: 3,
    };
    const liveRoot = join(sandbox, "original-here");
    mkdirSync(liveRoot, { recursive: true });
    const goneRoot = join(sandbox, "original-gone");
    const sessionOf = (id: string, fields: Partial<MirrorSessionRaw> = {}) =>
      rawMirrorSession({
        session: id,
        deviceId: LISTENER,
        projectId: "p",
        worktreeId: `wt-${id}`,
        localRoot: liveRoot,
        localWorktreeId: `orig-${id}`,
        labels: {
          [MIRROR_LABEL_MODE]: "mirror",
        },
        ...settled,
        ...fields,
      });
    const live = new Map<string, MirrorSessionRaw>();
    const put = (raw: MirrorSessionRaw) => live.set(raw.session, raw);
    const noted: Parameters<MirrorEngine["Service"]["noteEvent"]>[] = [];
    const deleted: string[] = [];
    const released: string[] = [];
    let status: Effect.Success<MirrorEngine["Service"]["status"]> = "running";
    let verdict: MirrorGitStatus = { status: "synced", detail: "" };
    let failTerminate = false;
    standInMirror({
      ...inertImpl(),
      status: Effect.sync(() => status),
      sessions: Effect.sync(() =>
        status === "running" ? [...live.values()] : [],
      ),
      terminate: (id) =>
        failTerminate
          ? Effect.fail(new MirrorError({ reason: "the engine is busy" }))
          : Effect.sync(() => {
              live.delete(id);
            }),
      gitStatus: () => verdict,
      refreshGit: () => Effect.sync(() => verdict),
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
      releaseCopy: (raw) =>
        Effect.sync(() => {
          released.push(raw.worktreeId);
        }),
    });
    // The peer's list never answers, which the copy-gone probe reads
    // as no answer (the copy may well be there), so no refusal is
    // waved through as a copy already gone.
    standInPeers({
      // The peer's own serving side, as far as this check asks it: the
      // copy's delete. Everything else refuses.
      transportFor: () => ({
        local: true,
        invoke: async (channel, input) => {
          const { worktreeId } = input as { worktreeId: string };
          if (channel === "worktrees:delete") {
            deleted.push(worktreeId);
            return { ok: true };
          }
          throw new Error("not in this check");
        },
        subscribe: () => () => {},
      }),
      channelsFor: () => () => Promise.reject(new Error("not in this check")),
    });
    standInDeviceId(DIALER);

    // Git in step but a file held still as a conflict: the copy may
    // hold the only version of it, so the unforced stop refuses,
    // naming why, and nothing is removed.
    put(
      sessionOf("conflicted", {
        conflicts: [{ root: "notes.md", localChanges: [], remoteChanges: [] }],
      }),
    );
    await assert.rejects(stop({ session: "conflicted" }), (error: unknown) => {
      assert.ok(isMirrorStopUnconfirmed(error));
      assert.match(errorMessageOf(error), /changed on both sides/);
      return true;
    });
    assert.ok(live.has("conflicted"));
    assert.deepEqual(deleted, []);
    // Removing it anyway is the user's call, made after being told.
    await stop({ session: "conflicted", force: true });
    assert.ok(!live.has("conflicted"));
    assert.deepEqual(deleted, ["wt-conflicted"]);

    // Files settled but git not: the fresh verdict is what decides.
    put(sessionOf("ahead"));
    verdict = { status: "following", detail: "to the other device" };
    await assert.rejects(stop({ session: "ahead" }), isMirrorStopUnconfirmed);
    verdict = { status: "synced", detail: "" };
    await stop({ session: "ahead" });
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);

    // The original removed outside the app: the copy is the only one
    // left, so even a forced stop keeps it, and its device is told it
    // is a plain worktree now.
    put(sessionOf("orphan", { localRoot: goneRoot }));
    assert.deepEqual(await stop({ session: "orphan", force: true }), {
      removedCopy: false,
    });
    assert.ok(!live.has("orphan"));
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);
    await waitFor(() => released.includes("wt-orphan"), "the release");
    assert.deepEqual(noted.at(-1), [
      "orig-orphan",
      "stopped",
      ORIGINAL_GONE_DETAIL,
    ]);

    // The same, found by the bookkeeping on a halted session, on a
    // session whose root goes after it was seen in place (whatever
    // the engine makes of that), and a session a re-open replaced
    // but which outlived it.
    put(
      sessionOf("halted", {
        localRoot: goneRoot,
        status: "halted-on-root-deletion",
      }),
    );
    const wentRoot = join(sandbox, "original-went");
    mkdirSync(wentRoot, { recursive: true });
    put(sessionOf("went", { localRoot: wentRoot }));
    put(sessionOf("old"));
    put(
      sessionOf("new", {
        localWorktreeId: "orig-old",
        labels: {
          [MIRROR_LABEL_MODE]: "mirror",
          [MIRROR_LABEL_REPLACES]: "old",
        },
      }),
    );
    // A re-open still running, and a root an in-app move holds, are
    // left to their owners. A terminate that fails is tried again.
    failTerminate = true;
    const release = holdRootChecks(["orig-halted"]);
    const sweptTo = async (
      expected: string[],
      settle: () => Promise<unknown> = settleBookkeeping,
    ) => {
      await settle();
      assert.deepEqual([...live.keys()].toSorted(), expected);
    };
    await sweptTo(["halted", "new", "old", "went"], () =>
      runHost(whileRecreating("old", settleMirrorBookkeeping)),
    );
    release();
    await sweptTo(["halted", "new", "old", "went"]);
    failTerminate = false;
    await sweptTo(["new", "went"]);
    // The root that was there goes: the next snapshot ends the
    // session, whatever the engine says about it (here a conflict at
    // the root, the copy having changed too), and two snapshots in
    // flight at once end it once.
    rmSync(wentRoot, { recursive: true });
    put(
      sessionOf("went", {
        localRoot: wentRoot,
        conflicts: [
          {
            root: "",
            localChanges: [{ path: "", kind: "deleted" }],
            remoteChanges: [{ path: "a.txt", kind: "modified" }],
          },
        ],
      }),
    );
    await sweptTo(["new"], () =>
      runHost(
        Effect.all([settleMirrorBookkeeping, settleMirrorBookkeeping], {
          concurrency: 2,
        }),
      ),
    );
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);
    assert.deepEqual(
      noted
        .filter(([, , detail]) => detail === ORIGINAL_GONE_DETAIL)
        .map(([id]) => id)
        .toSorted(),
      ["orig-halted", "orig-orphan", "orig-went"],
    );

    // A delete while the daemon restarts lists nothing to stop: the
    // stop waits for the daemon and ends the session once it runs.
    status = "starting";
    await runHost(stopMirrorsForWorktree("orig-old"));
    assert.ok(live.has("new"));
    status = "running";
    await settleBookkeeping();
    assert.ok(!live.has("new"));
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);

    // A root on a volume that isn't mounted (a drive unplugged or
    // asleep) reads as no such file too, and is no original gone: the
    // mirror waits for the drive.
    put(
      sessionOf("unplugged", {
        localRoot: "/Volumes/sm-proof-not-mounted/repo",
      }),
    );
    await settleBookkeeping();
    assert.ok(live.has("unplugged"));
    live.delete("unplugged");

    // What the mirror leaves out changes only on a pair in step.
    put(sessionOf("paused", { paused: true }));
    await assert.rejects(
      () =>
        runHost(
          mirrorHandlers.setIgnores({
            session: "paused",
            ignoreMode: "gitignored",
            ignores: [],
          }),
        ),
      /in step/,
    );
    live.clear();
  }
});

const labelled = (labels: Record<string, string>) =>
  ({ session: "old", labels }) as MirrorSessionRaw;

it("a session's mode says what it is, and a re-open carries it", () => {
  const token = beginTransfer();
  const transfer = labelled({ [MIRROR_LABEL_MODE]: transferModeFor(token) });
  assert.ok(isTransferSession(transfer));
  assert.ok(!isOrphanedTransfer(transfer));
  assert.ok(
    isOrphanedTransfer(labelled({ [MIRROR_LABEL_MODE]: "transfer-1" })),
  );
  const primary = labelled({ [MIRROR_LABEL_MODE]: "mirror-branch" });
  assert.ok(onMirrorBranch(primary) && !isTransferSession(primary));
  assert.ok(!onMirrorBranch(labelled({ [MIRROR_LABEL_MODE]: "mirror" })));
  // A session with no mode, or one this build does not know, is not a
  // mirror.
  assert.equal(
    Effect.runSync(
      mirrorSessions({
        sessions: Effect.succeed([
          labelled({}),
          labelled({ [MIRROR_LABEL_MODE]: "next" }),
        ]),
      }),
    ).length,
    0,
  );
  assert.deepEqual(carriedLabels(primary, { ignoreMode: "everything" }), {
    [MIRROR_LABEL_MODE]: "mirror-branch",
    replaces: "old",
    ignoreMode: "everything",
  });
});

it("the no-account sweep asks about each session once, so a misread credential ends nothing already running, and a sign-out while the daemon is down ends what it brings back", async () => {
  // (6f) The sweep of sessions the engine brings back for a device on
  // no account asks about each session once, signed in or not. A
  // credential that reads as signed out later (one bad read) ends
  // nothing that was already asked about. A session first seen while
  // signed out ends them all, a sign-out's reset asks again, and a
  // check that throws is asked again on the next snapshot.
  {
    let sessions: MirrorSessionRaw[] = [];
    let signedIn = true;
    let checks = 0;
    let ends = 0;
    const sweep = createNoAccountSweep({
      sessions: () => sessions,
      fresh: () => true,
      signedIn: () => {
        checks += 1;
        return signedIn;
      },
      end: () => {
        ends += 1;
      },
    });
    const one = rawMirrorSession({
      session: "s-1",
      deviceId: LISTENER,
      labels: {},
    });
    const two = rawMirrorSession({
      session: "s-2",
      deviceId: LISTENER,
      labels: {},
    });
    sweep.run();
    assert.equal(checks, 0, "nothing to ask about read the credential");
    sessions = [one];
    sweep.run();
    sweep.run();
    assert.equal(checks, 1, "a session was asked about twice");
    signedIn = false;
    sweep.run();
    assert.equal(ends, 0, "a misread ended a session already asked about");
    sessions = [one, two];
    sweep.run();
    assert.equal(ends, 1, "a session first seen signed out was kept");
    sweep.reset();
    sweep.run();
    assert.equal(ends, 2, "a reset sweep did not ask again");
    signedIn = true;
    const throwing = checks;
    const failing = createNoAccountSweep({
      sessions: () => sessions,
      fresh: () => true,
      signedIn: () => {
        checks += 1;
        if (checks === throwing + 1) throw new Error("no credential yet");
        return signedIn;
      },
      end: () => {
        ends += 1;
      },
    });
    assert.throws(() => failing.run(), /no credential yet/);
    failing.run();
    assert.equal(checks, throwing + 2, "a check that threw was not retried");
  }
  // Signed out while the daemon is down: the snapshot that stands
  // through the restart lists sessions it can't end, and the ones the
  // next run brings back are ended.
  {
    let running = false;
    let ended = 0;
    const sweep = createNoAccountSweep({
      sessions: () => [rawMirrorSession({ session: "s-1", labels: {} })],
      fresh: () => running,
      signedIn: () => false,
      end: () => {
        if (running) ended += 1;
      },
    });
    sweep.run();
    running = true;
    sweep.run();
    assert.equal(ended, 1, "the sessions the daemon brought back kept running");
  }
});

it("daemon stop is clean and the gateway holds no streams", async () => {
  // (7) Closing the daemon's layer ends it cleanly.
  const status = runtime.runSync(MirrorDaemon.onDaemon((d) => d.status));
  assert.equal(status, "running");
  await runtime.dispose();
  await delay(50);
  assert.equal(gatewayStreams(), 0);
});
