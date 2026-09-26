// Durable proof for continuous worktree mirroring (file-sync/,
// main/core/mirror/*, mirror:openStream): two REAL directories converge in
// both directions through the whole production chain, with nothing on
// the sync path doubled. Device B runs the REAL mirror daemon (a
// freshly built file-sync engine, Mutagen inside) behind the REAL
// gateway (main/core/mirror/gateway.ts). The gateway dials device A's REAL
// mirror:openStream over a REAL direct websocket (brokered by the stub
// device hub exactly as production does, test/lib/directBoot.mjs),
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
//   - B's primary checkout (the original, on the device running the
//     session) mirrored to a mirror/main worktree on A carries commits
//     both ways, and A's own main never moves.
// And the legacy sweep: a session an older build started from the
// copy's device is hidden from the mirror surfaces and ended once,
// its thread told why, with nothing deleted.
//
// Both "devices" share one node process and one sandboxed
// SHIGOMORI_DATA_DIR. What separates them is the direct wire between them,
// which is exactly the surface this proof pins. Runs under
// test/lib/register-ts-alias.mjs. Run: pnpm test mirror.
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
import { buildClient } from "@shared/ipc/buildClient";
import { forwardContract } from "@shared/ipc/modules/forward";
import {
  MIRROR_LABEL_COPY_SIDE,
  MIRROR_LABEL_MIRROR_BRANCH,
  MIRROR_LABEL_TRANSFER,
  mirrorContract,
} from "@shared/ipc/modules/mirror";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { setFileSyncSpawnImpl, spawnStreamChild } from "@host/fileSync/spawn";
import { forwardHandlers } from "@host/ipc/modules/forward";
import {
  listMirrorServing,
  mirrorHandlers,
  setMirrorImpl,
} from "@host/ipc/modules/mirror";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { createGitFollower } from "@host/mirror/gitFollow";
import {
  endLegacyMirrors,
  endMirrorsWithPeers,
  LEGACY_MIRROR_DETAIL,
  MIRROR_LABEL_LOCAL_WORKTREE,
  mirrorSessions,
} from "@host/mirror/registry";
import { transferFilesOnce } from "@host/mirror/oneShot";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import { createMirrorDaemon } from "../main/core/mirror/daemon.ts";
import { createMirrorGateway } from "../main/core/mirror/gateway.ts";
import {
  fileEquals,
  makeProof,
  makeTracker,
  repoRoot,
} from "./lib/checkKit.mjs";
import { cliSandbox } from "./lib/cliSandbox.mjs";
import { bootDirectWire } from "./lib/directBoot.mjs";
import { delay, processAlive, waitFor } from "./lib/checkKit.mjs";

const execFileP = promisify(execFile);
const fileSyncDir = join(repoRoot, "file-sync");

// Sandbox: everything (data dir, repos, the built binary, the
// daemon's data) under one temp tree, with process.env scrubbed and
// the fixture identity set for the commits below (cliSandbox). The
// document-run seam there is what the registered projects need (sm
// projects add).
const fixture = cliSandbox("sm-mirror-check-", {
  // The fsevents binding's deprecation warning would otherwise land in
  // the build output on macOS 13+ (see scripts/build-cli.mjs).
  CGO_CFLAGS: "-Wno-deprecated-declarations",
});
const { sandbox, smEnv, git, gitOut, addWorktree } = fixture;
const fileSyncBinary = join(sandbox, "file-sync");
const fileSyncDataDir = join(sandbox, "file-sync-data");

const read = (path) => readFileSync(path, "utf8");

// A serve child spawned by A's handler, observed through the same seam
// production uses, so "no child spawned" and "child gone" are facts
// about real processes.
const serveChildren = new Set();

const { ok, done, fail } = makeProof("mirror proof");

async function main() {
  console.log("mirror proof\n");

  // ---- Fixtures: build the CLI, seed A's repo and worktree, B's dir ----
  await Promise.all([
    fixture.buildSm(smEnv),
    execFileP("go", ["build", "-o", fileSyncBinary, "."], {
      cwd: fileSyncDir,
      env: smEnv,
    }),
  ]);

  const repoA = join(sandbox, "repo-a");
  await git(sandbox, ["init", "-q", "-b", "main", "repo-a"]);
  await fixture.commitFile(repoA, "readme.txt", "base\n", "base");
  const worktreeA = await addWorktree(repoA, "wt-a", "feature");
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
  const worktreeIdA = worktreeIdFromPath(worktreeA);

  // B's side is a REAL worktree of a clone of A's repository, on the
  // same branch at the same tip: the state a mirror start leaves behind
  // (the original here on B, which runs the session, the copy on A),
  // and what the git follower needs to have something to follow.
  const repoB = join(sandbox, "repo-b");
  await git(sandbox, ["clone", "-q", "--", repoA, "repo-b"]);
  const rootB = join(sandbox, "wt-b");
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
  const worktreeIdB = worktreeIdFromPath(rootB);

  fixture.useCli();
  // A's serve children, exactly as the app spawns them, plus the
  // observation seam.
  setFileSyncSpawnImpl((args) =>
    spawnStreamChild(fileSyncBinary, args, {
      env: smEnv,
      onSpawned: (child) => serveChildren.add(child),
    }),
  );
  const projectIdA = await fixture.projectIdOf(repoA);
  const projectIdB = await fixture.projectIdOf(repoB);

  // ---- The direct wire: A serves the byte wire and its worktree list,
  // B dials through the real bridge cache. ----
  const { track, teardown } = makeTracker();
  const { stub, listener, peerA } = await bootDirectWire(track, {
    contracts: [
      [forwardContract, forwardHandlers],
      [worktreesContract, worktreesHandlers],
      // The git follower's peer half: the transfer verbs (both
      // directions) and the mirror's git state pair.
      [syncContract, syncHandlers],
      [mirrorContract, mirrorHandlers],
    ],
  });
  const mirrorOverWire = buildClient(mirrorContract, peerA.transport);

  // B's half: the real gateway over the real peer client, the real
  // daemon on the freshly built binary.
  let changes = 0;
  const gateway = createMirrorGateway({
    peerApiFor: () => mirrorOverWire,
    peerChannelsFor: () => peerA.channels,
    log: () => {},
  });
  const daemon = createMirrorDaemon({
    // The daemon's env carries the gateway token, so the harness merges
    // it over its own rather than replacing it.
    spawn: (args, env) =>
      spawnStreamChild(fileSyncBinary, args, {
        env: { ...smEnv, ...env },
        onSpawned: (child) => track(() => child.kill("SIGKILL")),
      }),
    gatewayAddress: () => gateway.address(),
    gatewayToken: () => gateway.token(),
    dataDir: () => fileSyncDataDir,
    onChange: () => {
      changes++;
    },
    log: () => {},
  });
  track(() => daemon.stop());
  track(() => gateway.stop());

  try {
    await gateway.start();
    assert.match(gateway.address(), /^127\.0\.0\.1:\d+$/);
    daemon.start();
    await waitFor(
      () => daemon.status() === "running",
      "the daemon to report ready",
      30_000,
    );
    ok("gateway bound and the real mirror daemon reported ready");

    // The loopback port is reachable by every process on this machine,
    // so the preface token is what separates our own daemon from one
    // that merely found the port and would otherwise drive file
    // transfers against peer devices.
    {
      const [host, port] = gateway.address().split(":");
      const answer = await new Promise((resolve, reject) => {
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
      ok("gateway refuses a local process that cannot present its token");
    }

    const createInput = {
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
      (error) => /not permitted to run commands/.test(error.message),
    );
    assert.equal(
      serveChildren.size,
      0,
      "an ungranted open spawned a serve child",
    );
    assert.deepEqual(listMirrorServing(), []);
    ok(
      "ungranted peer: create fails with the grant refusal and A spawns nothing",
    );

    listener.setAccepts(true);

    // (2) Granted: the session comes up, seeded content crosses both
    // ways on the first cycle, the .git pointer stays on A.
    const hubBaseline = stub.forwardedCount();
    const session = await daemon.create(createInput);
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
    ok(
      "granted create: seeded files converge both ways, .git pointer held back",
    );

    // (3) The serving list on A names the worktree and the caller, and
    // exactly one serve child is alive.
    await waitFor(
      () => listMirrorServing().length === 1,
      "A to list one served mirror stream",
    );
    const [served] = listMirrorServing();
    assert.equal(served.projectId, projectIdA);
    assert.equal(served.worktreeId, worktreeIdA);
    assert.equal(served.peerDeviceId, "B");
    // The preface carried B's own worktree id for the pair.
    assert.equal(served.peerWorktreeId, worktreeIdB);
    assert.equal(serveChildren.size, 1);
    const [serveChild] = serveChildren;
    assert.ok(processAlive(serveChild.pid), "the serve child is not running");
    ok("A serves exactly one stream, attributed to worktree and caller");

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
      () =>
        fileEquals(join(worktreeA, "node_modules", "dep", "index.js"), "1\n"),
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
    ok(
      "live edits cross both ways, deletes propagate, the device hub stays flat",
    );

    // (5) The daemon's state stream describes the session in the app's
    // vocabulary.
    await waitFor(() => {
      const state = daemon.sessions().find((s) => s.session === session);
      return state !== undefined && state.status === "watching";
    }, "a watching snapshot");
    const state = daemon.sessions().find((s) => s.session === session);
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
    ok("the create's ignores hold: /dist stays on A while its sibling crosses");
    ok(
      "the state stream reports watching, both endpoints connected, cycles counted",
    );

    // ---- The git follower, against the same wire ----
    const follower = createGitFollower({
      sessions: () => daemon.sessions(),
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
    const gitStatus = () => follower.statusOf(session);
    const waitGit = (status, what) =>
      waitFor(() => gitStatus()?.status === status, what, 30_000);
    // Clean for the follower's purposes: nothing staged, nothing
    // modified. Untracked files (the mirrored fixture files, node_modules)
    // are expected on both sides.
    const clean = async (wt) =>
      (await gitOut(wt, "status", "--porcelain", "--untracked-files=no")) ===
      "";
    const gitHubBaseline = stub.forwardedCount();

    // (G1) Both sides agree from the start.
    follower.start();
    await waitGit("synced", "the follower to report synced");
    ok("git: a fresh session on equal tips reports synced");

    // (G2) A commit on A lands on B: tip, branch and a clean status.
    writeFileSync(join(worktreeA, "readme.txt"), "base, edited on A\n");
    await waitFor(
      () => fileEquals(join(rootB, "readme.txt"), "base, edited on A\n"),
      "the edit to mirror before the commit",
      30_000,
    );
    await git(worktreeA, ["add", "readme.txt"]);
    await git(worktreeA, ["commit", "-qm", "on A"]);
    const tipA1 = await gitOut(worktreeA, "rev-parse", "HEAD");
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
    await waitFor(
      () => clean(rootB),
      "B to read clean after the follow",
      30_000,
    );
    await waitGit("synced", "synced after A's commit");
    ok(
      "git: a commit on A lands on B with the same tip, branch and a clean status",
    );

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
    ok(
      "git: a file staged on A is staged on B, with the working tree untouched",
    );

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
    ok("git: a commit on B lands on A with the same tip and a clean status");

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
    const tipA2 = await gitOut(worktreeA, "rev-parse", "HEAD");
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
    assert.match(gitStatus().detail, /both sides have new commits/);
    assert.equal(await gitOut(worktreeA, "rev-parse", "HEAD"), tipA2);
    assert.equal(await gitOut(rootB, "rev-parse", "HEAD"), tipB2);
    ok("git: commits on both sides report diverged and move nothing");
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
    ok("git: dropping one side's commit lets the other side land again");

    // (G6) A branch collision: A checks out a branch that another
    // worktree on B already holds. Refused with the path, nothing
    // moves. Checking back on A restores sync.
    await addWorktree(repoB, "wt-b2", "other");
    await git(worktreeA, ["checkout", "-q", "-b", "other"]);
    follower.onPeerProjectChanged("A", projectIdA);
    await waitGit("blocked", "the follower to report blocked");
    assert.match(gitStatus().detail, /branch other is checked out at/);
    assert.equal(
      await gitOut(rootB, "symbolic-ref", "HEAD"),
      "refs/heads/feature",
    );
    ok(
      "git: a checkout on A to a branch held by another worktree on B is refused with the path",
    );
    await git(worktreeA, ["checkout", "-q", "feature"]);
    follower.onPeerProjectChanged("A", projectIdA);
    await waitGit("synced", "synced after A checks back");
    assert.equal(
      stub.forwardedCount(),
      gitHubBaseline,
      "the git follower rode the device hub instead of the direct socket",
    );
    ok("git: checking back on A restores sync, with the device hub still flat");

    // (G7) A primary checkout's mirror: B's repo-b itself, the
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
        [MIRROR_LABEL_COPY_SIDE]: "remote",
        [MIRROR_LABEL_MIRROR_BRANCH]: "1",
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
    const waitGit2 = (status, what) =>
      waitFor(
        () => follower.statusOf(session2)?.status === status,
        what,
        30_000,
      );
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
    assert.equal(
      await gitOut(repoB, "symbolic-ref", "HEAD"),
      "refs/heads/main",
    );
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
    assert.match(follower.statusOf(session2).detail, /without the mirror\//);
    assert.equal(
      await gitOut(repoB, "symbolic-ref", "HEAD"),
      "refs/heads/main",
    );
    await git(rootA2, ["checkout", "-q", "mirror/main"]);
    follower.onPeerProjectChanged("A", projectIdA);
    await waitGit2("synced", "synced once the copy is back on mirror/main");
    await daemon.terminate(session2);
    await waitFor(
      () => daemon.sessions().every((s) => s.session !== session2),
      "the primary's session to leave the state stream",
    );
    ok(
      "git: a primary mirrored to a mirror/main worktree carries commits both ways with the copy's own main untouched, and a stray branch on the copy is reported rather than followed",
    );
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
      () => !processAlive(serveChild.pid),
      "the serve child to exit",
      15_000,
    );
    assert.equal(read(join(rootB, "src.txt")), "from A, edited\n");
    assert.equal(read(join(worktreeA, "from-b.txt")), "from B\n");
    ok(
      "terminate drops the stream, ends the serve child, leaves both copies intact",
    );

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
      history: () => [],
      noteEvent: () => {},
      forgetHistory: () => {},
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
    ok(
      "one-shot transfer: the admitted file crosses, the rule holds, nothing flows back, the session ends itself",
    );

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
          {
            session: "s-with-a",
            deviceId: "A",
            labels: {
              [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-a",
              [MIRROR_LABEL_COPY_SIDE]: "remote",
            },
          },
        ],
        [
          "s-with-c",
          {
            session: "s-with-c",
            deviceId: "C",
            labels: {
              [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-c",
              [MIRROR_LABEL_COPY_SIDE]: "remote",
            },
          },
        ],
        [
          "t-with-a",
          {
            session: "t-with-a",
            deviceId: "A",
            labels: { [MIRROR_LABEL_TRANSFER]: "token" },
          },
        ],
      ]);
      const noted = [];
      setMirrorImpl({
        ...daemon,
        sessions: () => [...live.values()],
        terminate: async (id) => {
          live.delete(id);
        },
        recreate: () => Promise.reject(new Error("not in this check")),
        gitStatus: () => undefined,
        history: () => [],
        noteEvent: (worktreeId, kind, detail) =>
          noted.push([worktreeId, kind, detail]),
        forgetHistory: () => {},
      });
      await endMirrorsWithPeers((deviceId) => deviceId !== "A", "A left");
      assert.deepEqual([...live.keys()], ["s-with-c", "t-with-a"]);
      assert.deepEqual(noted, [["wt-a", "stopped", "A left"]]);
      await endMirrorsWithPeers(() => false, "signed out");
      assert.deepEqual([...live.keys()], ["t-with-a"]);
      assert.deepEqual(noted.at(-1), ["wt-c", "stopped", "signed out"]);
    }
    ok(
      "a device leaving the account ends the mirrors with it, copies kept, transfers untouched",
    );

    // (6d) A mirror an older build started from the copy's device (no
    // copySide label, host/mirror/registry.ts isLegacyMirror) is hidden
    // from every mirror surface and ended the first time it is seen,
    // once, its thread saying why. Nothing is deleted: the fake daemon
    // offers terminate and nothing else that removes. A labelled mirror
    // and a transfer session stay.
    {
      const legacy = {
        session: "s-legacy",
        deviceId: "A",
        status: "watching",
        labels: { [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-copy" },
      };
      const current = {
        session: "s-current",
        deviceId: "A",
        status: "watching",
        labels: {
          [MIRROR_LABEL_LOCAL_WORKTREE]: "wt-original",
          [MIRROR_LABEL_COPY_SIDE]: "remote",
        },
      };
      const transfer = {
        session: "t-legacy",
        deviceId: "A",
        status: "watching",
        labels: { [MIRROR_LABEL_TRANSFER]: "token" },
      };
      const live = new Map(
        [legacy, current, transfer].map((raw) => [raw.session, raw]),
      );
      const noted = [];
      const terminated = [];
      const impl = {
        ...daemon,
        status: () => "running",
        sessions: () => [...live.values()],
        terminate: async (id) => {
          terminated.push(id);
          live.delete(id);
        },
        recreate: () => Promise.reject(new Error("not in this check")),
        gitStatus: () => undefined,
        history: () => [],
        noteEvent: (worktreeId, kind, detail) =>
          noted.push([worktreeId, kind, detail]),
        forgetHistory: () => {},
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
    ok(
      "a mirror started from the copy's device by an older build is hidden, ended once on sight with a halted note, and nothing is deleted",
    );

    // (7) Stopping the daemon ends it cleanly.
    daemon.stop();
    await waitFor(() => daemon.status() === "stopped", "the daemon to stop");
    await delay(50);
    assert.equal(gateway.streamCount(), 0);
    ok("daemon stop is clean and the gateway holds no streams");

    done();
  } catch (error) {
    fail(error);
  } finally {
    // A serve child A spawned for a stream dies with its channel. After
    // a failure mid-scenario the channel may still be up, and the
    // child's stdio would keep this process alive.
    for (const child of serveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await teardown();
    fixture.remove();
  }
}

await main();
