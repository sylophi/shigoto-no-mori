// Durable proof that continuous worktree mirroring (file-sync/,
// host/mirror/*, mirror:openStream) never deletes or overwrites what
// isn't its own, through the whole production chain. The dialer runs
// the REAL mirror daemon (a freshly built file-sync engine, Mutagen
// inside) behind the REAL gateway (host/mirror/MirrorGateway.ts). The
// gateway dials the listener's REAL mirror:openStream over a REAL
// direct websocket (brokered by the stub device hub exactly as
// production does, test/lib/directBoot.mts), the listener's handler
// spawns a REAL `file-sync serve` for a REAL registered worktree. Bytes
// cross on a byte channel of the direct socket (shared/remote/channels.ts,
// bridged by host/portForward/bridge.ts). The sm CLI is built too, only
// to register the fixture project the way the app would. Asserts:
//   - a create converges seeded content both ways and holds each side's
//     .git pointer file back,
//   - a path under the create's ignores stays on its side.
// Then the git follower (host/mirror/gitFollow.ts), driven against the
// same wire with the dialer's worktree a real clone of the listener's repository:
//   - commits on both sides since they agreed report diverged and move
//     nothing,
//   - a checkout on the listener to a branch another worktree on the
//     dialer holds is refused, and nothing moves,
//   - a merge in progress on the listener, or a rebase on the dialer,
//     moves nothing until it finishes,
//   - the dialer's primary checkout (the original, on the device running the
//     session) mirrored to a mirror/main worktree on the listener carries commits
//     both ways, the listener's own main never moves, and a stray branch
//     on the copy is never followed,
//   - its apply (host/mirror/gitState.ts) to a checkout moved since its
//     read, onto another branch at the same tip or detached there, is
//     refused, the checkout left where it was.
// Then:
//   - terminating a session leaves both copies as they are,
//   - a one-shot pull never writes the dialer's files onto the listener,
//     and a replica pass never writes onto the original nor deletes what
//     its rule leaves out,
//   - a moved worktree re-opens only its own mirrors, at its new path,
//   - a stop refuses removing a copy unforced while a conflict or git
//     not in step (or not checked in time) may leave it the only
//     version, and an original gone, found by a stop or by the
//     bookkeeping, never takes its copy.
//
// Both "devices" share one node process and one sandboxed
// SHIGOMORI_DATA_DIR. What separates them is the direct wire between them,
// which is exactly the surface this proof pins. Run: pnpm test mirror.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, it } from "vitest";
import * as PeerReach from "@host/ipc/PeerReach";
import { forwardContract } from "@shigomori/contracts/modules/forward";
import {
  MIRROR_LABEL_MODE,
  isMirrorStopUnconfirmed,
  mirrorContract,
  type MirrorGitStatus,
} from "@shigomori/contracts/modules/mirror";
import type { Project } from "@shigomori/contracts/schemas";
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
import { applyGitState, readGitState } from "@host/mirror/gitState";
import {
  type MirrorSessionRaw,
  ORIGINAL_GONE_DETAIL,
  settleMirrorBookkeeping,
  moveMirrorsOfWorktree,
} from "@host/mirror/registry";
import { transferFilesOnce } from "@host/mirror/oneShot";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as MirrorDaemon from "../host/mirror/MirrorDaemon.ts";
import * as MirrorGateway from "../host/mirror/MirrorGateway.ts";
import { fileEquals, makeTracker, repoRoot, waitFor } from "./lib/checkKit.mts";
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

const execFileP = promisify(execFile);
const fileSyncDir = join(repoRoot, "file-sync");

// Sandbox: everything (data dir, repos, the built binary, the
// daemon's data) under one temp tree, with process.env scrubbed and
// the fixture identity set for the commits below (cliSandbox). The
// document-run seam there is what the registered projects need (sm
// projects add).

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

// The dialer's daemon and the listener's serve children, on the freshly built binary
// (built in beforeAll).
const fileSync = FileSync.layer(() => fileSyncBinary);

// The dialer's daemon, the way host/process/handlers.ts reads it.
const daemon = {
  status: () => runtime.runSync(MirrorDaemon.onDaemon((d) => d.status)),
  sessions: () => runtime.runSync(MirrorDaemon.onDaemon((d) => d.sessions)),
  create: (input: MirrorCreateInput) =>
    runtime.runPromise(MirrorDaemon.onDaemon((d) => d.create(input))),
  terminate: (id: string) =>
    runtime.runPromise(MirrorDaemon.onDaemon((d) => d.terminate(id))),
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
let listener: DirectWire["listener"];
let toListener: DirectWire["toListener"];
let gateway: ManagedRuntime.ManagedRuntime<MirrorGateway.MirrorGateway, never>;
let runtime: ManagedRuntime.ManagedRuntime<MirrorDaemon.MirrorDaemon, never>;
let session: string;
let follower: GitFollower;
let followerScope: Scope.Closeable;

const { track, teardown } = makeTracker();

// Every daemon snapshot reaches the git follower while it runs, as
// host/process/handlers.ts wires it.
let onSnapshot: (() => void) | null = null;

const gitStatus = () => follower.statusOf(session);
const stopFollower = () =>
  Effect.runPromise(Scope.close(followerScope, Exit.void));
const waitGit = (status: MirrorGitStatus["status"], what: string) =>
  waitFor(() => gitStatus()?.status === status, what, 30_000);

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
  ({ listener, toListener } = await bootDirectWire(track, {
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

  // The dialer's daemon, behind the gateway once it has bound.
  await gatewayAddress();
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

afterAll(async () => {
  await teardown();
  await fixture.remove();
});

it("granted create: seeded files converge both ways, .git pointer held back", async () => {
  listener.setAccepts(true);

  // The session comes up, seeded content crosses both ways on the
  // first cycle, the .git pointer stays on each side.
  session = await daemon.create({
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
  });
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

it("git: commits on both sides report diverged and move nothing", async () => {
  // ---- The git follower, against the same wire ----
  followerScope = Effect.runSync(Scope.make());
  track(stopFollower);
  follower = await runHost(
    makeGitFollower({
      sessions: Effect.sync(() => daemon.sessions()),
      sweepMs: 60_000,
      log: (message) => console.log(message),
    }).pipe(Scope.provide(followerScope)),
  );
  onSnapshot = () => follower.sessionsChanged();
  // Both sides agree from the start.
  await waitGit("synced", "the follower to report synced");
  // Commits on both sides since they agreed: diverged, nothing moves.
  writeFileSync(join(listenerWorktree, "a-only.txt"), "a\n");
  await waitFor(
    () => fileEquals(join(dialerRoot, "a-only.txt"), "a\n"),
    "a-only.txt to mirror",
    30_000,
  );
  await git(listenerWorktree, ["add", "a-only.txt"]);
  await git(listenerWorktree, ["commit", "-qm", "diverge on the listener"]);
  const listenerTip = await gitOut(listenerWorktree, "rev-parse", "HEAD");
  writeFileSync(join(dialerRoot, "b-only.txt"), "b\n");
  await waitFor(
    () => fileEquals(join(listenerWorktree, "b-only.txt"), "b\n"),
    "b-only.txt to mirror",
    30_000,
  );
  await git(dialerRoot, ["add", "b-only.txt"]);
  await git(dialerRoot, ["commit", "-qm", "diverge on the dialer"]);
  const dialerTip = await gitOut(dialerRoot, "rev-parse", "HEAD");
  follower.onLocalProjectChanged(dialerProjectId);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("diverged", "the follower to report diverged");
  assert.equal(
    await gitOut(listenerWorktree, "rev-parse", "HEAD"),
    listenerTip,
  );
  assert.equal(await gitOut(dialerRoot, "rev-parse", "HEAD"), dialerTip);
  // Resolved on the dialer for what follows, by dropping its own
  // commit: only the listener has moved since they agreed, so the
  // follower carries the listener's commit over.
  await git(dialerRoot, ["reset", "-q", "--hard", "HEAD~1"]);
  follower.onLocalProjectChanged(dialerProjectId);
  await waitFor(
    async () => (await gitOut(dialerRoot, "rev-parse", "HEAD")) === listenerTip,
    "the dialer to follow the listener once its own commit is dropped",
    30_000,
  );
  await waitGit("synced", "synced after resolving the divergence");
});

it("git: a checkout on the listener to a branch held by another worktree on the dialer is refused, and nothing moves", async () => {
  await addWorktree(dialerRepo, "dialer-wt2", "other");
  await git(listenerWorktree, ["checkout", "-q", "-b", "other"]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("blocked", "the follower to refuse the held branch");
  assert.equal(
    await gitOut(dialerRoot, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
  // Back on its branch for what follows.
  await git(listenerWorktree, ["checkout", "-q", "feature"]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit("synced", "synced after the listener checks back");
});

it("git: a merge on the listener or a rebase on the dialer moves nothing until it finishes", async () => {
  // A git operation in progress on either side blocks the follow, and
  // nothing moves until it finishes.
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
  assert.equal(
    await gitOut(listenerWorktree, "symbolic-ref", "HEAD"),
    "refs/heads/feature",
  );
  await git(dialerRoot, ["rebase", "--abort"]);
  follower.onLocalProjectChanged(dialerProjectId);
  await waitGit("synced", "synced after the dialer's rebase was aborted");
});

it("git: a primary mirrored to a mirror/main worktree carries commits both ways with the copy's own main untouched, and a stray branch on the copy is never followed", async () => {
  // A primary checkout's mirror: the dialer's repo itself, the
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
  // The copy leaving the mirror/ rule is not followed: the dialer's
  // primary stays on main until the copy is back on a mirror/ branch.
  await git(listenerRoot2, ["checkout", "-q", "-b", "stray"]);
  follower.onPeerProjectChanged(LISTENER, listenerProjectId);
  await waitGit2("blocked", "the follower to report the stray branch");
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

for (const [name, moved, move] of [
  [
    "moved-branch",
    "onto another branch at the same tip",
    ["checkout", "-q", "-b", "beta"],
  ],
  [
    "moved-detached",
    "detached at the same tip",
    ["checkout", "-q", "--detach"],
  ],
] as const) {
  it(`git: an apply to a checkout moved ${moved} since its read is refused, its HEAD kept`, async () => {
    // The state an apply would carry stages one edit, and the index is
    // put back to HEAD, so the apply has something to move.
    const repo = await fixture.initRepo(name);
    await fixture.commitFile(repo, "a.txt", "a\n", "a");
    writeFileSync(join(repo, "a.txt"), "staged\n");
    await git(repo, ["add", "a.txt"]);
    const wanted = await runHost(readGitState(repo, repo, "wt"));
    await git(repo, ["reset", "-q"]);
    const current = await runHost(readGitState(repo, repo, "wt"));
    assert.notEqual(current.indexTree, wanted.indexTree);
    await git(repo, [...move]);
    const head = await gitOut(repo, "rev-parse", "--abbrev-ref", "HEAD");
    assert.deepEqual(
      await runHost(
        applyGitState(
          // As a project the apply reads only its path.
          { path: repo } as Project,
          { id: "wt", path: repo },
          { expect: current, state: wanted },
        ),
      ),
      { applied: false, refusal: { kind: "changed-locally" } },
    );
    assert.equal(await gitOut(repo, "rev-parse", "--abbrev-ref", "HEAD"), head);
  });
}

it("terminate leaves both copies intact", async () => {
  onSnapshot = null;
  await stopFollower();

  // The session is gone, the listener's stream dropped, and the files
  // stay put on both sides.
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
  assert.equal(read(join(dialerRoot, "src.txt")), "from the listener\n");
  assert.equal(read(join(listenerWorktree, "from-b.txt")), "from the dialer\n");
});

it("one-shot transfer: the admitted file crosses, the rule holds, nothing flows back", async () => {
  // A transplant's files step (host/mirror/oneShot.ts): the same
  // daemon run once with the leave-out rule's patterns, settled on
  // its first cycle and ended by itself. A path under the rule stays
  // on the listener, one beside it crosses, and nothing of the
  // dialer's reaches the listener. Only the daemon slot's
  // create/sessions/terminate/status are in play. The rest of the impl
  // is inert here.
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

it("replica pass: the copy takes the original's version of a clash and loses what only it held, while the original and what the rule leaves out are untouched", async () => {
  // A mirror start's first pass (mirror:startTo): the copy (the listener)
  // made an exact copy of the original (the dialer) before the two-way session
  // opens. A path both hold differently (what a carry-over or a setup
  // script wrote on the copy) takes the original's version instead of
  // standing as a conflict, what only the copy holds goes, the original
  // keeps its own, and a path under the rule is left alone on the copy.
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

it("stop: a conflict or git not in step refuses removing the copy unforced, and an original gone never takes its copy, found by a stop or by the bookkeeping, whatever the engine calls it", async () => {
  // The stop's safety and its keep-the-copy, and the original gone
  // behind the app's back. Against a recording daemon and a recording
  // peer: what is pinned is which session ends and which copy the peer
  // is asked to delete.
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
    let verdict: MirrorGitStatus = { status: "synced", detail: "" };
    let timedOut = false;
    standInMirror({
      ...inertImpl(),
      status: Effect.succeed("running"),
      sessions: Effect.sync(() => [...live.values()]),
      terminate: (id) =>
        Effect.sync(() => {
          live.delete(id);
        }),
      gitStatus: () => verdict,
      refreshGit: () => Effect.sync(() => (timedOut ? "timed-out" : verdict)),
      noteEvent: (worktreeId, kind, detail) =>
        noted.push([worktreeId, kind, detail]),
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
    // hold the only version of it, so the unforced stop refuses, and
    // nothing is removed.
    put(
      sessionOf("conflicted", {
        conflicts: [{ root: "notes.md", localChanges: [], remoteChanges: [] }],
      }),
    );
    await assert.rejects(
      stop({ session: "conflicted" }),
      isMirrorStopUnconfirmed,
    );
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
    // A look at git that ran out of time is no verdict.
    timedOut = true;
    await assert.rejects(stop({ session: "ahead" }), isMirrorStopUnconfirmed);
    timedOut = false;
    await stop({ session: "ahead" });
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);

    // The original removed outside the app: the copy is the only one
    // left, so even a forced stop keeps it.
    put(sessionOf("orphan", { localRoot: goneRoot }));
    assert.deepEqual(await stop({ session: "orphan", force: true }), {
      removedCopy: false,
    });
    assert.ok(!live.has("orphan"));
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);

    // The same, found by the bookkeeping on a halted session, and on a
    // session whose root goes after it was seen in place: the next
    // snapshot ends it, whatever the engine says about it (here a
    // conflict at the root, the copy having changed too).
    put(
      sessionOf("halted", {
        localRoot: goneRoot,
        status: "halted-on-root-deletion",
      }),
    );
    const wentRoot = join(sandbox, "original-went");
    mkdirSync(wentRoot, { recursive: true });
    put(sessionOf("went", { localRoot: wentRoot }));
    await settleBookkeeping();
    assert.deepEqual([...live.keys()], ["went"]);
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
    await settleBookkeeping();
    assert.deepEqual([...live.keys()], []);
    assert.deepEqual(deleted, ["wt-conflicted", "wt-ahead"]);
    assert.deepEqual(
      noted
        .filter(([, , detail]) => detail === ORIGINAL_GONE_DETAIL)
        .map(([id]) => id)
        .toSorted(),
      ["orig-halted", "orig-orphan", "orig-went"],
    );
  }
});
