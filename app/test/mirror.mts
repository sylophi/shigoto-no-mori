// Durable proof for continuous worktree mirroring (file-sync/,
// main/core/mirror/*, mirror:openStream): two REAL directories converge in
// both directions through the whole production chain, with nothing on
// the sync path doubled. Device B runs the REAL mirror daemon (a
// freshly built file-sync engine, Mutagen inside) behind the REAL
// gateway (main/core/mirror/gateway.ts). The gateway dials device A's REAL
// mirror:openStream over a REAL direct websocket (brokered by the stub
// device hub exactly as production does, test/lib/directBoot.mts),
// A's handler spawns a REAL `file-sync serve` for a REAL registered
// worktree. Bytes cross as binary channel frames on the direct socket
// (shared/ipc/socket/channels.ts, bridged by
// main/core/portForward/bridge.ts). The sm CLI is built too, only to
// register the fixture project the way the app would. Asserts:
//   - an ungranted peer: the gateway's open is refused, the daemon's
//     create fails with the refusal, and A spawned no serve child,
//   - a granted create converges seeded content both ways, including a
//     gitignored-style file, and holds A's .git pointer file back,
//   - live edits after the first cycle cross both ways within seconds,
//     and a delete propagates, while the device hub's forwardedCount
//     stays FLAT (only the direct socket carries the stream),
//   - A's serving list names the worktree and the caller while the
//     stream is up, and empties when the session is terminated, with
//     the serve child gone,
//   - the daemon's state stream reports the session in the app's
//     vocabulary (watching, both endpoints connected, cycles counted),
//   - stopping the daemon ends it and the gateway closes clean.
// Then the git follower (host/mirror/gitFollow.ts), driven against the
// same wire with B's worktree a real clone of A's repository:
//   - a commit on A lands on B: same tip, same branch, clean status,
//   - staging on A shows as staged on B, without touching files,
//   - a commit on B lands on A the same way (the push direction),
//   - commits on both sides since they agreed report diverged and move
//     nothing, and resolving on B brings the session back to synced,
//   - a checkout on A to a branch another worktree on B holds is
//     refused with the path, and checking back restores sync,
//   - a merge in progress on A, or a rebase on B, reports blocked with
//     the operation and side named and moves nothing, and finishing it
//     resumes the follow,
//   - a half-landed apply (B's ref already at A's tip, its index not)
//     heals to synced rather than reading as diverged,
//   - a commit waits while the engine reports the files mid-cycle (or
//     halted), staging does not, and the idle snapshot releases it,
//   - B's primary checkout (the original, on the device running the
//     session) mirrored to a mirror/main worktree on A carries commits
//     both ways, and A's own main never moves.
// And the legacy sweep: a session an older build started from the
// copy's device is hidden from the mirror surfaces and ended once,
// its thread told why, with nothing deleted. And a peer's removed
// worktree (worktrees:removal) ends only the sessions into that copy.
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
import { buildClient } from "@shared/ipc/buildClient";
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
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FileSync from "@host/fileSync/FileSync";
import { forwardHandlers } from "@host/ipc/modules/forward";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { type MirrorCreateInput, setMirrorImpl } from "@host/mirror/registry";
import { listMirrorServing } from "@host/mirror/serving";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { createGitFollower } from "@host/mirror/gitFollow";
import { setPeerSyncApiImpl } from "@host/ipc/peerSync";
import {
  COPY_GONE_DETAIL,
  createNoAccountSweep,
  endLegacyMirrors,
  endMirrorsOnPeerRemoval,
  endMirrorsWithPeers,
  LEGACY_MIRROR_DETAIL,
  MIRROR_LABEL_LOCAL_WORKTREE,
  type MirrorImpl,
  mirrorSessions,
  type MirrorSessionRaw,
  holdRootChecks,
  ORIGINAL_GONE_DETAIL,
  settleMirrorBookkeeping,
  stopMirrorsForWorktree,
  whileRecreating,
} from "@host/mirror/registry";
import { transferFilesOnce } from "@host/mirror/oneShot";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import * as MirrorDaemon from "../main/core/mirror/daemon.ts";
import { createMirrorGateway } from "../main/core/mirror/gateway.ts";
import { fileEquals, makeTracker, repoRoot, waitFor } from "./lib/checkKit.mts";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { bootDirectWire, type DirectWire } from "./lib/directBoot.mts";
import { delay, processAlive } from "./lib/checkKit.mts";

const execFileP = promisify(execFile);
const fileSyncDir = join(repoRoot, "file-sync");

// Sandbox: everything (data dir, repos, the built binary, the
// daemon's data) under one temp tree, with process.env scrubbed and
// the fixture identity set for the commits below (cliSandbox). The
// document-run seam there is what the registered projects need (sm
// projects add).
const fixture = cliSandbox("sm-mirror-check-", {
  // The fsevents binding's deprecation warning would otherwise land in
  // the build output on macOS 13+ (see scripts/build-cli.mts).
  CGO_CFLAGS: "-Wno-deprecated-declarations",
});
const { sandbox, smEnv, git, gitOut, addWorktree } = fixture;
const fileSyncBinary = join(sandbox, "file-sync");
const fileSyncDataDir = join(sandbox, "file-sync-data");

const read = (path: string) => readFileSync(path, "utf8");

// The gateway's facts the daemon is handed, once it has them, as main
// hands them over (main/ipc/handlers.ts).
function listening<T>(value: T | null): T {
  if (value === null) throw new Error("mirror gateway is not listening");
  return value;
}

// A session for the fake daemons below, which only read its id, its
// peer and its labels.
const idleEndpoint: MirrorSessionRaw["local"] = {
  connected: false,
  scanned: false,
  directories: 0,
  files: 0,
  symbolicLinks: 0,
  totalFileSize: 0,
  problems: [],
  excludedProblems: 0,
};
const fakeSession = (
  fields: Pick<MirrorSessionRaw, "session" | "deviceId" | "labels"> &
    Partial<MirrorSessionRaw>,
): MirrorSessionRaw => ({
  name: fields.session,
  localRoot: "",
  projectId: "",
  worktreeId: "",
  remoteRoot: "",
  paused: false,
  ignores: [],
  createdAt: 0,
  status: "watching",
  statusText: "",
  successfulCycles: 0,
  conflicts: [],
  excludedConflicts: 0,
  local: idleEndpoint,
  remote: idleEndpoint,
  ...fields,
});

// The pids of the serve children A's handler spawned, observed through
// the FileSync service production uses, so "no child spawned" and
// "child gone" are facts about real processes.
const serveChildren = new Set<number>();

// B's daemon, the way main/ipc/handlers.ts reads it.
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

// mirror:stop called the way a caller on this device would, its
// context unread by the handler.
const stop = async (input: Parameters<typeof mirrorHandlers.stop>[0]) =>
  mirrorHandlers.stop(input, {} as Parameters<typeof mirrorHandlers.stop>[1]);

let repoA: string;
let worktreeA: string;
let worktreeIdA: string;
let repoB: string;
let rootB: string;
let worktreeIdB: string;
let projectIdA: string;
let projectIdB: string;
let stub: DirectWire["stub"];
let listener: DirectWire["listener"];
let peerA: DirectWire["peerA"];
let mirrorOverWire: ReturnType<typeof buildClient<typeof mirrorContract>>;
let gateway: ReturnType<typeof createMirrorGateway>;
let runtime: ManagedRuntime.ManagedRuntime<MirrorDaemon.MirrorDaemon, never>;
let createInput: MirrorCreateInput;
let hubBaseline: number;
let session: string;
let servePid: number;
let follower: ReturnType<typeof createGitFollower>;
let gitHubBaseline: number;
let tipA1: string;
let tipA2: string;

const { track, teardown } = makeTracker();

let changes = 0;
// Every daemon snapshot reaches the git follower while it runs, as
// main/ipc/handlers.ts wires it.
let onSnapshot: (() => void) | null = null;

// The engine status the follower sees, overridable so a mid-cycle
// or halted engine can be posed on demand (G9).
let filesStatus: MirrorSession["status"] | null = null;
const gitStatus = () => follower.statusOf(session);
const waitGit = (status: MirrorGitStatus["status"], what: string) =>
  waitFor(() => gitStatus()?.status === status, what, 30_000);
// Clean for the follower's purposes: nothing staged, nothing
// modified. Untracked files (the mirrored fixture files, node_modules)
// are expected on both sides.
const clean = async (wt: string) =>
  (await gitOut(wt, "status", "--porcelain", "--untracked-files=no")) === "";

beforeAll(async () => {
  // ---- Fixtures: build the CLI, seed A's repo and worktree, B's dir ----
  await Promise.all([
    fixture.buildSm(),
    execFileP("go", ["build", "-o", fileSyncBinary, "."], {
      cwd: fileSyncDir,
      env: smEnv,
    }),
  ]);

  repoA = join(sandbox, "repo-a");
  await git(sandbox, ["init", "-q", "-b", "main", "repo-a"]);
  await fixture.commitFile(repoA, "readme.txt", "base\n", "base");
  worktreeA = await addWorktree(repoA, "wt-a", "feature");
  // The content that must cross on the first cycle: a tracked file, a
  // nested one, a gitignored-looking one. And the .git POINTER FILE of
  // a linked worktree, which must never cross.
  writeFileSync(join(worktreeA, "src.txt"), "from A\n");
  mkdirSync(join(worktreeA, "deep", "er"), { recursive: true });
  writeFileSync(join(worktreeA, "deep", "er", "leaf.txt"), "leaf\n");
  writeFileSync(join(worktreeA, ".env"), "SECRET=1\n");
  assert.ok(
    existsSync(join(worktreeA, ".git")) &&
      read(join(worktreeA, ".git")).startsWith("gitdir:"),
    "fixture: the linked worktree's .git is a pointer file",
  );
  worktreeIdA = worktreeIdFromPath(worktreeA);

  // B's side is a REAL worktree of a clone of A's repository, on the
  // same branch at the same tip: the state a mirror start leaves behind
  // (the original here on B, which runs the session, the copy on A),
  // and what the git follower needs to have something to follow.
  repoB = join(sandbox, "repo-b");
  await git(sandbox, ["clone", "-q", "--", repoA, "repo-b"]);
  rootB = join(sandbox, "wt-b");
  await git(repoB, [
    "worktree",
    "add",
    "-q",
    "-b",
    "feature",
    rootB,
    "origin/feature",
  ]);
  writeFileSync(join(rootB, "from-b.txt"), "from B\n");
  worktreeIdB = worktreeIdFromPath(rootB);

  fixture.useCli();
  projectIdA = await fixture.projectIdOf(repoA);
  projectIdB = await fixture.projectIdOf(repoB);

  // ---- The direct wire: A serves the byte wire and its worktree list,
  // B dials through the real bridge cache. ----
  ({ stub, listener, peerA } = await bootDirectWire(track, {
    contracts: [
      [forwardContract, forwardHandlers],
      [worktreesContract, worktreesHandlers],
      // The git follower's peer half: the transfer verbs (both
      // directions) and the mirror's git state pair.
      [syncContract, syncHandlers],
      [mirrorContract, mirrorHandlers],
    ],
  }));
  mirrorOverWire = buildClient(mirrorContract, peerA.transport);

  // B's half: the real gateway over the real peer client, the real
  // daemon on the freshly built binary.
  gateway = createMirrorGateway({
    peerApiFor: () => mirrorOverWire,
    peerChannelsFor: () => peerA.channels,
    log: () => {},
  });
  track(() => gateway.stop());
});

afterAll(async () => {
  await teardown();
  fixture.remove();
});

it("gateway bound and the real mirror daemon reported ready", async () => {
  await gateway.start();
  assert.match(listening(gateway.address()), /^127\.0\.0\.1:\d+$/);
  // B's daemon and A's serve children, on the freshly built binary.
  const fileSync = Layer.effect(
    FileSync.FileSync,
    Effect.gen(function* () {
      const real = yield* FileSync.FileSync;
      return FileSync.FileSync.of({
        ...real,
        serve: (env) =>
          real
            .serve(env)
            .pipe(
              Effect.tap((child) =>
                Effect.sync(() => serveChildren.add(child.pid)),
              ),
            ),
      });
    }),
  ).pipe(Layer.provide(FileSync.layer(() => fileSyncBinary)));
  runtime = ManagedRuntime.make(
    MirrorDaemon.layer({
      gatewayAddress: () => listening(gateway.address()),
      gatewayToken: () => listening(gateway.token()),
      dataDir: () => fileSyncDataDir,
      onChange: () => {
        changes++;
        onSnapshot?.();
      },
    }).pipe(
      Layer.provideMerge(FileSync.adapter),
      Layer.provideMerge(fileSync),
      Layer.provide(NodeServices.layer),
    ),
  );
  track(() => runtime.dispose());
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
  const [host, port] = listening(gateway.address()).split(":");
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = netConnect(Number(port), host, () => {
      socket.write(
        `${JSON.stringify({
          deviceId: "A",
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
    gateway.streamCount(),
    0,
    "the refused connection was bridged anyway",
  );
});

it("ungranted peer: create fails with the grant refusal and A spawns nothing", async () => {
  createInput = {
    localRoot: rootB,
    deviceId: "A",
    projectId: projectIdA,
    worktreeId: worktreeIdA,
    remoteRoot: worktreeA,
    name: "feature",
    localWorktreeId: worktreeIdB,
    labels: { localWorktreeId: worktreeIdB, localProjectId: projectIdB },
    // A build folder held back by the create's own ignores.
    ignores: ["/dist"],
  };

  // (1) Ungranted: the gateway's openStream is refused on A's wire, so
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
  // ways on the first cycle, the .git pointer stays on A.
  hubBaseline = stub.forwardedCount();
  session = await daemon.create(createInput);
  assert.match(session, /^sync_/);
  await waitFor(
    () =>
      fileEquals(join(rootB, "src.txt"), "from A\n") &&
      fileEquals(join(rootB, "deep", "er", "leaf.txt"), "leaf\n") &&
      fileEquals(join(rootB, ".env"), "SECRET=1\n") &&
      fileEquals(join(worktreeA, "from-b.txt"), "from B\n"),
    "the seeded content to converge both ways",
    60_000,
  );
  // Each side keeps its OWN .git pointer: A's names repo-a's gitdir,
  // B's names repo-b's, and neither crossed.
  assert.match(
    read(join(rootB, ".git")),
    /repo-b/,
    "B's .git pointer was overwritten",
  );
  assert.match(
    read(join(worktreeA, ".git")),
    /repo-a/,
    "A's .git pointer was overwritten",
  );
});

it("A serves exactly one stream, attributed to worktree and caller", async () => {
  // (3) The serving list on A names the worktree and the caller, and
  // exactly one serve child is alive.
  await waitFor(
    () => listMirrorServing().length === 1,
    "A to list one served mirror stream",
  );
  const [served] = listMirrorServing();
  assert.ok(served !== undefined, "A lists no served mirror stream");
  assert.equal(served.projectId, projectIdA);
  assert.equal(served.worktreeId, worktreeIdA);
  assert.equal(served.peerDeviceId, "B");
  // The preface carried B's own worktree id for the pair.
  assert.equal(served.peerWorktreeId, worktreeIdB);
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
  writeFileSync(join(worktreeA, "src.txt"), "from A, edited\n");
  await waitFor(
    () => fileEquals(join(rootB, "src.txt"), "from A, edited\n"),
    "A's edit to reach B",
    30_000,
  );
  mkdirSync(join(rootB, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(rootB, "node_modules", "dep", "index.js"), "1\n");
  await waitFor(
    () => fileEquals(join(worktreeA, "node_modules", "dep", "index.js"), "1\n"),
    "B's nested write to reach A",
    30_000,
  );
  rmSync(join(worktreeA, ".env"));
  await waitFor(
    () => !existsSync(join(rootB, ".env")),
    "A's delete to reach B",
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
  assert.equal(state.deviceId, "A");
  assert.equal(state.projectId, projectIdA);
  assert.equal(state.worktreeId, worktreeIdA);
  assert.equal(state.localRoot, rootB);
  assert.equal(state.remoteRoot, worktreeA);
  assert.equal(state.labels.localWorktreeId, worktreeIdB);
  assert.equal(state.local.connected, true);
  assert.equal(state.remote.connected, true);
  assert.ok(state.successfulCycles >= 1);
  assert.deepEqual(state.conflicts, []);
  assert.deepEqual(state.ignores, ["/dist"]);
  assert.ok(state.createdAt > 0, "the session carries no creation time");
  assert.ok(changes > 0, "the daemon never signalled a change");
});

it("the create's ignores hold: /dist stays on A while its sibling crosses", async () => {
  // The ignore held: a file under it on A never reached B while the
  // sibling beside it did.
  mkdirSync(join(worktreeA, "dist"), { recursive: true });
  writeFileSync(join(worktreeA, "dist", "bundle.js"), "built\n");
  writeFileSync(join(worktreeA, "beside-dist.txt"), "crosses\n");
  await waitFor(
    () => fileEquals(join(rootB, "beside-dist.txt"), "crosses\n"),
    "the sibling of the ignored folder to reach B",
    30_000,
  );
  assert.ok(
    !existsSync(join(rootB, "dist", "bundle.js")),
    "an ignored path crossed to B",
  );
});

it("git: a fresh session on equal tips reports synced", async () => {
  // ---- The git follower, against the same wire ----
  follower = createGitFollower({
    sessions: () => {
      const sessions = daemon.sessions();
      if (filesStatus === null) return sessions;
      const status = filesStatus;
      return sessions.map((s) => Object.assign({}, s, { status }));
    },
    // The sync surface and the session's byte channels, which the
    // follower's source links ride.
    peerSyncApiFor: () => ({
      ...buildClient(syncContract, peerA.transport),
      channels: peerA.channels,
    }),
    peerMirrorApiFor: () => buildClient(mirrorContract, peerA.transport),
    sweepMs: 60_000,
    log: (message) => console.log(message),
  });
  track(() => follower.stop());
  onSnapshot = () => follower.sessionsChanged();
  gitHubBaseline = stub.forwardedCount();

  // (G1) Both sides agree from the start.
  follower.start();
  await waitGit("synced", "the follower to report synced");
});

it("git: a commit on A lands on B with the same tip, branch and a clean status", async () => {
  // (G2) A commit on A lands on B: tip, branch and a clean status.
  writeFileSync(join(worktreeA, "readme.txt"), "base, edited on A\n");
  await waitFor(
    () => fileEquals(join(rootB, "readme.txt"), "base, edited on A\n"),
    "the edit to mirror before the commit",
    30_000,
  );
  await git(worktreeA, ["add", "readme.txt"]);
  await git(worktreeA, ["commit", "-qm", "on A"]);
  tipA1 = await gitOut(worktreeA, "rev-parse", "HEAD");
  // What A's git-directory watcher would push in production.
  follower.onPeerProjectChanged("A", projectIdA);
  await waitFor(
    async () => (await gitOut(rootB, "rev-parse", "HEAD")) === tipA1,
    "B's tip to follow A's commit",
    30_000,
  );
  assert.equal(
    await gitOut(rootB, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
  await waitFor(() => clean(rootB), "B to read clean after the follow", 30_000);
  await waitGit("synced", "synced after A's commit");
});

it("git: a file staged on A is staged on B, with the working tree untouched", async () => {
  // (G3) Staging on A shows as staged on B, files untouched.
  await git(worktreeA, ["add", "src.txt"]);
  // What A's served-index watcher would push in production.
  follower.onPeerWorktreeChanged("A", projectIdA, worktreeIdA);
  await waitFor(
    async () =>
      (await gitOut(rootB, "diff", "--cached", "--name-only")) === "src.txt",
    "src.txt to show as staged on B",
    30_000,
  );
  assert.equal(read(join(rootB, "src.txt")), "from A, edited\n");
  await waitGit("synced", "synced after A's stage");
});

it("git: a commit on B lands on A with the same tip and a clean status", async () => {
  // (G4) A commit on B lands on A (the push direction).
  await git(rootB, ["commit", "-qm", "on B"]);
  const tipB1 = await gitOut(rootB, "rev-parse", "HEAD");
  assert.notEqual(tipB1, tipA1);
  // B's own index watcher fires on the commit. The project ping is
  // what the local git-directory watcher would add.
  follower.onLocalProjectChanged(projectIdB);
  await waitFor(
    async () => (await gitOut(worktreeA, "rev-parse", "HEAD")) === tipB1,
    "A's tip to follow B's commit",
    30_000,
  );
  await waitFor(
    () => clean(worktreeA),
    "A to read clean after the follow",
    30_000,
  );
  await waitGit("synced", "synced after B's commit");
});

it("git: commits on both sides report diverged and move nothing", async () => {
  // (G5) Commits on both sides since they agreed: diverged, nothing
  // moves, and resolving on B restores sync.
  writeFileSync(join(worktreeA, "a-only.txt"), "a\n");
  await waitFor(
    () => fileEquals(join(rootB, "a-only.txt"), "a\n"),
    "a-only.txt to mirror",
    30_000,
  );
  await git(worktreeA, ["add", "a-only.txt"]);
  await git(worktreeA, ["commit", "-qm", "diverge on A"]);
  tipA2 = await gitOut(worktreeA, "rev-parse", "HEAD");
  writeFileSync(join(rootB, "b-only.txt"), "b\n");
  await waitFor(
    () => fileEquals(join(worktreeA, "b-only.txt"), "b\n"),
    "b-only.txt to mirror",
    30_000,
  );
  await git(rootB, ["add", "b-only.txt"]);
  await git(rootB, ["commit", "-qm", "diverge on B"]);
  const tipB2 = await gitOut(rootB, "rev-parse", "HEAD");
  follower.onLocalProjectChanged(projectIdB);
  follower.onPeerProjectChanged("A", projectIdA);
  await waitGit("diverged", "the follower to report diverged");
  assert.match(gitStatus()?.detail ?? "", /both sides have new commits/);
  assert.equal(await gitOut(worktreeA, "rev-parse", "HEAD"), tipA2);
  assert.equal(await gitOut(rootB, "rev-parse", "HEAD"), tipB2);
});

it("git: dropping one side's commit lets the other side land again", async () => {
  // Resolve on B by dropping its own commit: B is back at the tip
  // both sides last agreed on, so only A has moved and the follower
  // carries A's commit over. (The reset also removes b-only.txt from
  // B's tree, and the engine mirrors that removal to A, where it was
  // never committed.)
  await git(rootB, ["reset", "-q", "--hard", "HEAD~1"]);
  // The staged b-only.txt is gone from the index but the file stays
  // (the engine mirrors it), which is the ordinary dirty case.
  follower.onLocalProjectChanged(projectIdB);
  await waitFor(
    async () => (await gitOut(rootB, "rev-parse", "HEAD")) === tipA2,
    "B to follow A once B's own commit is dropped",
    30_000,
  );
  await waitGit("synced", "synced after resolving the divergence");
});

it("git: a checkout on A to a branch held by another worktree on B is refused with the path", async () => {
  // (G6) A branch collision: A checks out a branch that another
  // worktree on B already holds. Refused with the path, nothing
  // moves. Checking back on A restores sync.
  await addWorktree(repoB, "wt-b2", "other");
  await git(worktreeA, ["checkout", "-q", "-b", "other"]);
  follower.onPeerProjectChanged("A", projectIdA);
  await waitGit("blocked", "the follower to report blocked");
  assert.match(gitStatus()?.detail ?? "", /branch other is checked out at/);
  assert.equal(
    await gitOut(rootB, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
});

it("git: checking back on A restores sync, with the device hub still flat", async () => {
  await git(worktreeA, ["checkout", "-q", "feature"]);
  follower.onPeerProjectChanged("A", projectIdA);
  await waitGit("synced", "synced after A checks back");
  assert.equal(
    stub.forwardedCount(),
    gitHubBaseline,
    "the git follower rode the device hub instead of the direct socket",
  );
});

it("git: a merge on A or a rebase on B reports blocked with the side named, moves nothing, and finishing it resumes the follow", async () => {
  // (G7) A git operation in progress on either side blocks the
  // follow, naming the side, and nothing moves until it finishes.
  // A merge stopped before its commit on A (a no-ff merge of a commit
  // with the same tree, so no file changes):
  const sideTip = await gitOut(
    worktreeA,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "side",
  );
  await git(worktreeA, ["update-ref", "refs/heads/side-op", sideTip]);
  const tipBeforeOps = await gitOut(rootB, "rev-parse", "HEAD");
  await git(worktreeA, ["merge", "-q", "--no-ff", "--no-commit", "side-op"]);
  follower.onPeerProjectChanged("A", projectIdA);
  await waitGit("blocked", "the follower to report A's merge");
  assert.match(
    gitStatus()?.detail ?? "",
    /a merge is in progress on the other device/,
  );
  assert.equal(await gitOut(rootB, "rev-parse", "HEAD"), tipBeforeOps);
  await git(worktreeA, ["commit", "-qm", "merge side-op"]);
  const mergeTip = await gitOut(worktreeA, "rev-parse", "HEAD");
  follower.onPeerProjectChanged("A", projectIdA);
  await waitFor(
    async () => (await gitOut(rootB, "rev-parse", "HEAD")) === mergeTip,
    "B to follow A's finished merge",
    30_000,
  );
  await waitGit("synced", "synced after A's merge finished");
  // A rebase stopped on B (an exec that fails leaves it mid-way, on a
  // detached HEAD), which must not reach A as a detached HEAD:
  await assert.rejects(() =>
    git(rootB, ["rebase", "--exec", "false", "HEAD~1"]),
  );
  follower.onLocalProjectChanged(projectIdB);
  await waitGit("blocked", "the follower to report B's rebase");
  assert.match(gitStatus()?.detail ?? "", /a rebase is in progress here/);
  assert.equal(
    await gitOut(worktreeA, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
  await git(rootB, ["rebase", "--abort"]);
  follower.onLocalProjectChanged(projectIdB);
  await waitGit("synced", "synced after B's rebase was aborted");
});

it("git: a half-landed apply heals to synced instead of reading diverged", async () => {
  // (G8) A half-landed apply heals: B's branch already at A's new
  // tip (as if read-tree failed on a held index lock after the ref
  // moved), its index still the old tree. Both tips moved since the
  // agreement, yet the two share one now, so only the indexes count.
  writeFileSync(join(worktreeA, "half.txt"), "half\n");
  await waitFor(
    () => fileEquals(join(rootB, "half.txt"), "half\n"),
    "half.txt to mirror",
    30_000,
  );
  await git(worktreeA, ["add", "half.txt"]);
  await git(worktreeA, ["commit", "-qm", "half-applied on B"]);
  const halfTip = await gitOut(worktreeA, "rev-parse", "HEAD");
  await git(repoB, ["fetch", "-q", repoA, "feature"]);
  await git(rootB, ["update-ref", "refs/heads/feature", halfTip]);
  assert.notEqual(await gitOut(rootB, "diff", "--cached", "--name-only"), "");
  follower.onLocalProjectChanged(projectIdB);
  await waitFor(
    async () => (await gitOut(rootB, "diff", "--cached", "--name-only")) === "",
    "B's index to heal to A's",
    30_000,
  );
  await waitGit("synced", "synced after the half-landed apply healed");
  assert.ok(await clean(rootB), "B is not clean after the heal");
});

it("git: a commit waits for the files (staging does not), a halted engine reads blocked, and the idle snapshot releases it", async () => {
  // (G9) Git follows the files: a commit waits while the engine is
  // mid-cycle, staging does not, a halted engine reads blocked, and
  // the idle snapshot releases the wait.
  writeFileSync(join(worktreeA, "wait.txt"), "wait\n");
  await waitFor(
    () => fileEquals(join(rootB, "wait.txt"), "wait\n"),
    "wait.txt to mirror",
    30_000,
  );
  const tipBeforeWait = await gitOut(rootB, "rev-parse", "HEAD");
  filesStatus = "staging-remote";
  await git(worktreeA, ["add", "wait.txt"]);
  follower.onPeerWorktreeChanged("A", projectIdA, worktreeIdA);
  await waitFor(
    async () =>
      (await gitOut(rootB, "diff", "--cached", "--name-only")) === "wait.txt",
    "staging to cross while the files are mid-cycle",
    30_000,
  );
  await git(worktreeA, ["commit", "-qm", "wait for files"]);
  const waitTip = await gitOut(worktreeA, "rev-parse", "HEAD");
  follower.onPeerProjectChanged("A", projectIdA);
  await waitFor(
    () => gitStatus()?.detail === "waiting for files to catch up",
    "the commit to wait for the files",
    30_000,
  );
  assert.equal(gitStatus()?.status, "following");
  assert.equal(await gitOut(rootB, "rev-parse", "HEAD"), tipBeforeWait);
  filesStatus = "halted-on-root-deletion";
  follower.onPeerProjectChanged("A", projectIdA);
  await waitGit("blocked", "a halted engine to read blocked");
  assert.match(gitStatus()?.detail ?? "", /file sync has halted/);
  assert.equal(await gitOut(rootB, "rev-parse", "HEAD"), tipBeforeWait);
  filesStatus = null;
  // The engine's idle snapshot, as the daemon would send it.
  follower.sessionsChanged();
  await waitFor(
    async () => (await gitOut(rootB, "rev-parse", "HEAD")) === waitTip,
    "B to follow once the files are idle",
    30_000,
  );
  await waitGit("synced", "synced after the files caught up");
});

it("git: a primary mirrored to a mirror/main worktree carries commits both ways with the copy's own main untouched, and a stray branch on the copy is reported rather than followed", async () => {
  // (G10) A primary checkout's mirror: B's repo-b itself, the
  // original on the device running the session, mirrored to A as a
  // worktree on mirror/main (the session's mirrorBranch label),
  // beside A's own primary on main. The follower reads the two names
  // as one: a commit on B's main lands on A's mirror/main, one there
  // lands on B's main, and A's own main never moves.
  const rootA2 = join(sandbox, "wt-a-mirror");
  await git(repoA, [
    "worktree",
    "add",
    "-q",
    "-b",
    "mirror/main",
    rootA2,
    "main",
  ]);
  const worktreeIdA2 = worktreeIdFromPath(rootA2);
  const primaryIdB = worktreeIdFromPath(repoB);
  const mainBefore = await gitOut(repoA, "rev-parse", "HEAD");
  const session2 = await daemon.create({
    localRoot: repoB,
    deviceId: "A",
    projectId: projectIdA,
    worktreeId: worktreeIdA2,
    remoteRoot: rootA2,
    name: "main",
    localWorktreeId: primaryIdB,
    labels: {
      localWorktreeId: primaryIdB,
      localProjectId: projectIdB,
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
  writeFileSync(join(repoB, "primary-b.txt"), "b\n");
  await waitFor(
    () => fileEquals(join(rootA2, "primary-b.txt"), "b\n"),
    "primary-b.txt to mirror",
    30_000,
  );
  await git(repoB, ["add", "primary-b.txt"]);
  await git(repoB, ["commit", "-qm", "on B's primary"]);
  const tipB3 = await gitOut(repoB, "rev-parse", "HEAD");
  follower.onLocalProjectChanged(projectIdB);
  await waitFor(
    async () => (await gitOut(rootA2, "rev-parse", "HEAD")) === tipB3,
    "A's mirror/main to follow B's primary",
    30_000,
  );
  assert.equal(
    await gitOut(rootA2, "symbolic-ref", "HEAD"),
    "refs/heads/mirror/main",
  );
  await waitGit2("synced", "synced after B's primary committed");
  writeFileSync(join(rootA2, "primary-a.txt"), "a\n");
  await waitFor(
    () => fileEquals(join(repoB, "primary-a.txt"), "a\n"),
    "primary-a.txt to mirror",
    30_000,
  );
  await git(rootA2, ["add", "primary-a.txt"]);
  await git(rootA2, ["commit", "-qm", "on A's mirror/main"]);
  const tipA3 = await gitOut(rootA2, "rev-parse", "HEAD");
  follower.onPeerProjectChanged("A", projectIdA);
  await waitFor(
    async () => (await gitOut(repoB, "rev-parse", "HEAD")) === tipA3,
    "B's primary to follow A's mirror/main",
    30_000,
  );
  assert.equal(await gitOut(repoB, "symbolic-ref", "HEAD"), "refs/heads/main");
  await waitGit2("synced", "synced after A's mirror/main committed");
  assert.equal(
    await gitOut(repoA, "rev-parse", "HEAD"),
    mainBefore,
    "A's own primary must not move",
  );
  // The copy leaving the mirror/ rule is reported, not followed: B's
  // primary stays on main until the copy is back on a mirror/ branch.
  await git(rootA2, ["checkout", "-q", "-b", "stray"]);
  follower.onPeerProjectChanged("A", projectIdA);
  await waitGit2("blocked", "the follower to report the stray branch");
  assert.match(
    follower.statusOf(session2)?.detail ?? "",
    /without the mirror\//,
  );
  assert.equal(await gitOut(repoB, "symbolic-ref", "HEAD"), "refs/heads/main");
  await git(rootA2, ["checkout", "-q", "mirror/main"]);
  follower.onPeerProjectChanged("A", projectIdA);
  await waitGit2("synced", "synced once the copy is back on mirror/main");
  await daemon.terminate(session2);
  await waitFor(
    () => daemon.sessions().every((s) => s.session !== session2),
    "the primary's session to leave the state stream",
  );
});

it("terminate drops the stream, ends the serve child, leaves both copies intact", async () => {
  onSnapshot = null;
  follower.stop();

  // (6) Terminate: the session is gone, A's stream dropped, the serve
  // child exited, and the files stay put on both sides.
  await daemon.terminate(session);
  await waitFor(
    () => daemon.sessions().every((s) => s.session !== session),
    "the session to leave the state stream",
  );
  await waitFor(
    () => listMirrorServing().length === 0,
    "A's serving list to empty",
    15_000,
  );
  await waitFor(
    () => !processAlive(servePid),
    "the serve child to exit",
    15_000,
  );
  assert.equal(read(join(rootB, "src.txt")), "from A, edited\n");
  assert.equal(read(join(worktreeA, "from-b.txt")), "from B\n");
});

it("one-shot transfer: the admitted file crosses, the rule holds, nothing flows back, the session ends itself", async () => {
  // (6b) A transplant's files step (host/mirror/oneShot.ts): the same
  // daemon run once with the leave-out rule's patterns, settled on
  // its first cycle and ended by itself. A path under the rule stays
  // on A, one beside it crosses, and no session survives the call.
  // Only the daemon slot's create/sessions/terminate/status are in
  // play. The rest of the impl is inert here.
  setMirrorImpl({
    ...daemon,
    recreate: () => Promise.reject(new Error("not in this check")),
    gitStatus: () => undefined,
    refreshGit: async () => undefined,
    history: () => [],
    noteEvent: () => {},
    forgetHistory: () => {},
    moveHistory: () => {},
  });
  mkdirSync(join(worktreeA, "skip"), { recursive: true });
  writeFileSync(join(worktreeA, "skip", "me.txt"), "stays\n");
  writeFileSync(join(worktreeA, "once.txt"), "once\n");
  // Only on B: a pull is one way, so it must never reach A.
  writeFileSync(join(rootB, "local-only.txt"), "mine\n");
  const once = await transferFilesOnce(
    {
      localRoot: rootB,
      localWorktreeId: worktreeIdB,
      sourceDeviceId: "A",
      sourceProjectId: projectIdA,
      sourceWorktreeId: worktreeIdA,
      remoteRoot: worktreeA,
      name: "feature",
      ignores: ["/skip"],
    },
    () => {},
  );
  assert.deepEqual(once, { crossed: true, conflicts: 0 });
  assert.equal(read(join(rootB, "once.txt")), "once\n");
  assert.equal(
    existsSync(join(rootB, "skip")),
    false,
    "a path under the transfer's rule crossed",
  );
  assert.equal(
    existsSync(join(worktreeA, "local-only.txt")),
    false,
    "a pull pushed B's own file onto A",
  );
  await waitFor(
    () => daemon.sessions().length === 0,
    "the one-shot session to be gone",
  );
  await waitFor(
    () => listMirrorServing().length === 0,
    "A's serving list to empty after the one-shot",
    15_000,
  );
});

it("replica pass: the copy takes the original's version of a clash, loses what only it held, keeps what the rule leaves out", async () => {
  // (6b') A mirror start's first pass (mirror:startTo): the copy (A)
  // made an exact copy of the original (B) before the two-way session
  // opens. A path both hold differently (what a carry-over or a setup
  // script wrote on the copy) takes the original's version instead of
  // standing as a conflict, what only the copy holds goes, and a path
  // under the rule is left alone on the copy.
  writeFileSync(join(rootB, "clash.txt"), "the original's\n");
  writeFileSync(join(worktreeA, "clash.txt"), "the copy's create\n");
  writeFileSync(join(worktreeA, "stray.txt"), "only on the copy\n");
  const replica = await transferFilesOnce(
    {
      localRoot: rootB,
      localWorktreeId: worktreeIdB,
      sourceDeviceId: "A",
      sourceProjectId: projectIdA,
      sourceWorktreeId: worktreeIdA,
      remoteRoot: worktreeA,
      name: "feature",
      ignores: ["/skip"],
      direction: "replica",
    },
    () => {},
  );
  assert.deepEqual(replica, { crossed: true, conflicts: 0 });
  assert.equal(read(join(worktreeA, "clash.txt")), "the original's\n");
  assert.equal(read(join(rootB, "clash.txt")), "the original's\n");
  assert.equal(existsSync(join(worktreeA, "stray.txt")), false);
  assert.equal(read(join(worktreeA, "skip", "me.txt")), "stays\n");
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
        fakeSession({
          session: "s-with-a",
          deviceId: "A",
          labels: {
            [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-a",
            [MIRROR_LABEL_MODE]: "mirror",
          },
        }),
      ],
      [
        "s-with-c",
        fakeSession({
          session: "s-with-c",
          deviceId: "C",
          // A session from before the mode label, which reads as a
          // mirror through its old one.
          labels: {
            [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-c",
            copySide: "remote",
          },
        }),
      ],
      [
        "t-with-a",
        fakeSession({
          session: "t-with-a",
          deviceId: "A",
          labels: { [MIRROR_LABEL_MODE]: "transfer-token" },
        }),
      ],
    ]);
    const noted: Parameters<MirrorImpl["noteEvent"]>[] = [];
    setMirrorImpl({
      ...daemon,
      sessions: () => [...live.values()],
      terminate: async (id) => {
        live.delete(id);
      },
      recreate: () => Promise.reject(new Error("not in this check")),
      gitStatus: () => undefined,
      refreshGit: async () => undefined,
      history: () => [],
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
      forgetHistory: () => {},
      moveHistory: () => {},
    });
    await endMirrorsWithPeers((deviceId) => deviceId !== "A", "A left");
    assert.deepEqual([...live.keys()], ["s-with-c", "t-with-a"]);
    assert.deepEqual(noted, [["wt-a", "stopped", "A left"]]);
    await endMirrorsWithPeers(() => false, "signed out");
    assert.deepEqual([...live.keys()], ["t-with-a"]);
    assert.deepEqual(noted.at(-1), ["wt-c", "stopped", "signed out"]);
  }
});

it("a mirror started from the copy's device by an older build is hidden, ended once on sight with a halted note, and nothing is deleted", async () => {
  // (6d) A mirror an older build started from the copy's device (no
  // copySide label, host/mirror/registry.ts isLegacyMirror) is hidden
  // from every mirror surface and ended the first time it is seen,
  // once, its thread saying why. Nothing is deleted: the fake daemon
  // offers terminate and nothing else that removes. A labelled mirror
  // and a transfer session stay.
  {
    const legacy = fakeSession({
      session: "s-legacy",
      deviceId: "A",
      status: "watching",
      labels: { [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-copy" },
    });
    const current = fakeSession({
      session: "s-current",
      deviceId: "A",
      status: "watching",
      labels: {
        [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-original",
        [MIRROR_LABEL_MODE]: "mirror",
      },
    });
    const transfer = fakeSession({
      session: "t-legacy",
      deviceId: "A",
      status: "watching",
      labels: { [MIRROR_LABEL_MODE]: "transfer-token" },
    });
    const live = new Map(
      [legacy, current, transfer].map((raw): [string, MirrorSessionRaw] => [
        raw.session,
        raw,
      ]),
    );
    const noted: Parameters<MirrorImpl["noteEvent"]>[] = [];
    const terminated: string[] = [];
    const impl: MirrorImpl = {
      ...daemon,
      status: () => "running",
      sessions: () => [...live.values()],
      terminate: async (id) => {
        terminated.push(id);
        live.delete(id);
      },
      recreate: () => Promise.reject(new Error("not in this check")),
      gitStatus: () => undefined,
      refreshGit: async () => undefined,
      history: () => [],
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
      forgetHistory: () => {},
      moveHistory: () => {},
    };
    setMirrorImpl(impl);
    assert.deepEqual(
      mirrorSessions(impl).map((raw) => raw.session),
      ["s-current"],
      "a legacy mirror reached the mirror surfaces",
    );
    await endLegacyMirrors();
    assert.deepEqual(terminated, ["s-legacy"]);
    assert.deepEqual(noted, [["wt-copy", "halted", LEGACY_MIRROR_DETAIL]]);
    assert.match(LEGACY_MIRROR_DETAIL, /start it again from the original/i);
    // Seen again (a snapshot that still names it), it is not asked twice.
    live.set(legacy.session, legacy);
    await endLegacyMirrors();
    assert.deepEqual(terminated, ["s-legacy"]);
    assert.deepEqual([...live.keys()].toSorted(), [
      "s-current",
      "s-legacy",
      "t-legacy",
    ]);
  }
});

it("a peer's removed worktree ends only the mirrors into that copy, nothing deleted", async () => {
  // (6e) A copy deleted on its own device: that device announces
  // the removal (worktrees:removal) and this one, which runs the
  // session, ends it once the removal is done. Only the sessions into
  // the announced copy end, each original's thread says why, and
  // nothing is deleted. Another device's worktree of the same id
  // stays.
  {
    const into = (
      id: string,
      deviceId: string,
      worktreeId: string,
      original: string,
    ) =>
      fakeSession({
        session: id,
        deviceId,
        projectId: "p",
        worktreeId,
        labels: {
          [MIRROR_LABEL_LOCAL_WORKTREE]: original,
          [MIRROR_LABEL_MODE]: "mirror",
        },
      });
    const live = new Map(
      [
        into("s-into-a", "A", "wt-copy", "wt-original"),
        into("s-into-a-other", "A", "wt-other", "wt-original-2"),
        into("s-into-c", "C", "wt-copy", "wt-original-3"),
      ].map((raw): [string, MirrorSessionRaw] => [raw.session, raw]),
    );
    const noted: Parameters<MirrorImpl["noteEvent"]>[] = [];
    setMirrorImpl({
      ...daemon,
      status: () => "running",
      sessions: () => [...live.values()],
      terminate: async (id) => {
        live.delete(id);
      },
      recreate: () => Promise.reject(new Error("not in this check")),
      gitStatus: () => undefined,
      refreshGit: async () => undefined,
      history: () => [],
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
      forgetHistory: () => {},
      moveHistory: () => {},
    });
    const copy = { projectId: "p", worktreeId: "wt-copy" };
    await endMirrorsOnPeerRemoval("A", { ...copy, state: "removing" });
    await endMirrorsOnPeerRemoval("A", { ...copy, state: "kept" });
    assert.equal(live.size, 3, "a removal not yet done ended a mirror");
    await endMirrorsOnPeerRemoval("A", { ...copy, state: "removed" });
    assert.deepEqual([...live.keys()], ["s-into-a-other", "s-into-c"]);
    assert.deepEqual(noted, [["wt-original", "stopped", COPY_GONE_DETAIL]]);
    // Announced twice (the stop's own end, then the announcement), it
    // ends nothing more.
    await endMirrorsOnPeerRemoval("A", { ...copy, state: "removed" });
    assert.equal(noted.length, 1);
  }
});

it("stop: a conflict or git not in step refuses removing the copy unforced, an original gone never takes its copy and says so, and leftovers and delayed stops are swept, sparing a running re-open and a held root and retrying a failed end", async () => {
  // (6e) The stop's safety and its keep-the-copy, the original gone
  // behind the app's back, a re-open's leftover, and a stop that
  // came while the daemon was down. Against a recording daemon and
  // a recording peer: what is pinned is which session ends, what the
  // peer is asked, and what the thread says.
  {
    const settled: Partial<MirrorSessionRaw> = {
      status: "watching",
      successfulCycles: 3,
      local: { ...idleEndpoint, connected: true, scanned: true },
      remote: { ...idleEndpoint, connected: true, scanned: true },
    };
    const liveRoot = join(sandbox, "original-here");
    mkdirSync(liveRoot, { recursive: true });
    const goneRoot = join(sandbox, "original-gone");
    const sessionOf = (id: string, fields: Partial<MirrorSessionRaw> = {}) =>
      fakeSession({
        session: id,
        deviceId: "A",
        projectId: "p",
        worktreeId: `wt-${id}`,
        localRoot: liveRoot,
        labels: {
          [MIRROR_LABEL_LOCAL_WORKTREE]: `orig-${id}`,
          [MIRROR_LABEL_MODE]: "mirror",
        },
        ...settled,
        ...fields,
      });
    const live = new Map<string, MirrorSessionRaw>();
    const put = (raw: MirrorSessionRaw) => live.set(raw.session, raw);
    const noted: Parameters<MirrorImpl["noteEvent"]>[] = [];
    const deleted: string[] = [];
    const released: string[] = [];
    let status: ReturnType<MirrorImpl["status"]> = "running";
    let verdict: MirrorGitStatus = { status: "synced", detail: "" };
    let failTerminate = false;
    setMirrorImpl({
      ...daemon,
      status: () => status,
      sessions: () => (status === "running" ? [...live.values()] : []),
      terminate: async (id) => {
        if (failTerminate) throw new Error("the engine is busy");
        live.delete(id);
      },
      recreate: () => Promise.reject(new Error("not in this check")),
      gitStatus: () => verdict,
      refreshGit: async () => verdict,
      history: () => [],
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
      forgetHistory: () => {},
      moveHistory: () => {},
    });
    // The peer's list never answers, which the copy-gone probe reads
    // as no answer (the copy may well be there), so no refusal is
    // waved through as a copy already gone.
    setPeerSyncApiImpl({
      syncApiFor: () => {
        throw new Error("not in this check");
      },
      worktreesApiFor: () => ({
        list: () => Promise.reject(new Error("not in this check")),
        delete: async ({ worktreeId }) => {
          deleted.push(worktreeId);
          return { ok: true as const };
        },
        setShelved: () => Promise.reject(new Error("not in this check")),
      }),
      mirrorApiFor: () => ({
        gitState: () => Promise.reject(new Error("not in this check")),
        applyGitState: () => Promise.reject(new Error("not in this check")),
        startTo: () => Promise.reject(new Error("not in this check")),
        release: async ({ worktreeId }) => {
          released.push(worktreeId);
        },
      }),
      worktreeDataApiFor: () => {
        throw new Error("not in this check");
      },
      thisDeviceId: () => "B",
    });

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

    // The same, found by the bookkeeping on a halted session, and a
    // session a re-open replaced but which outlived it.
    put(
      sessionOf("halted", {
        localRoot: goneRoot,
        status: "halted-on-root-deletion",
      }),
    );
    put(sessionOf("old"));
    put(
      sessionOf("new", {
        labels: {
          [MIRROR_LABEL_LOCAL_WORKTREE]: "orig-old",
          [MIRROR_LABEL_MODE]: "mirror",
          [MIRROR_LABEL_REPLACES]: "old",
        },
      }),
    );
    // A re-open still running, and a root an in-app move holds, are
    // left to their owners. A terminate that fails is tried again.
    failTerminate = true;
    const release = holdRootChecks(["orig-halted"]);
    await whileRecreating("old", () => settleMirrorBookkeeping());
    assert.deepEqual([...live.keys()].toSorted(), ["halted", "new", "old"]);
    release();
    await settleMirrorBookkeeping();
    assert.deepEqual([...live.keys()].toSorted(), ["halted", "new", "old"]);
    failTerminate = false;
    await settleMirrorBookkeeping();
    assert.deepEqual([...live.keys()].toSorted(), ["new"]);
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);

    // A delete while the daemon restarts lists nothing to stop: the
    // stop waits for the daemon and ends the session once it runs.
    status = "starting";
    await stopMirrorsForWorktree("orig-old");
    assert.ok(live.has("new"));
    status = "running";
    await settleMirrorBookkeeping();
    assert.ok(!live.has("new"));
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);

    // What the mirror leaves out changes only on a pair in step.
    put(sessionOf("paused", { paused: true }));
    await assert.rejects(
      async () =>
        mirrorHandlers.setIgnores(
          { session: "paused", ignoreMode: "gitignored", ignores: [] },
          {} as Parameters<typeof mirrorHandlers.setIgnores>[1],
        ),
      /in step/,
    );
    live.clear();
  }
});

it("the no-account sweep asks about each session once, so a misread credential ends nothing already running", async () => {
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
      signedIn: () => {
        checks += 1;
        return signedIn;
      },
      end: () => {
        ends += 1;
      },
    });
    const one = fakeSession({ session: "s-1", deviceId: "A", labels: {} });
    const two = fakeSession({ session: "s-2", deviceId: "A", labels: {} });
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
});

it("daemon stop is clean and the gateway holds no streams", async () => {
  // (7) Closing the daemon's layer ends it cleanly.
  const status = runtime.runSync(MirrorDaemon.onDaemon((d) => d.status));
  assert.equal(status, "running");
  await runtime.dispose();
  await delay(50);
  assert.equal(gateway.streamCount(), 0);
});
