// Durable proof for continuous worktree mirroring (file-sync/,
// main/mirror/*, forward:openMirror): two REAL directories converge in
// both directions through the whole production chain, with nothing on
// the sync path doubled. Device B runs the REAL mirror daemon (a
// freshly built file-sync engine, Mutagen inside) behind the REAL
// gateway (main/mirror/gateway.ts); the gateway dials device A's REAL
// forward:openMirror over a REAL direct websocket (brokered by the stub
// device hub exactly as production does, scripts/lib/directBoot.mjs);
// A's handler spawns a REAL `file-sync serve` for a REAL registered
// worktree; bytes cross as binary channel frames on the direct socket
// (shared/ipc/socket/channels.ts, bridged by main/portForward/bridge.ts). The sm CLI is built too, only to
// register the fixture project the way the app would. Asserts:
//   - an ungranted peer: the gateway's open is refused, the daemon's
//     create fails with the refusal, and A spawned no serve child;
//   - a granted create converges seeded content both ways, including a
//     gitignored-style file, and holds A's .git pointer file back;
//   - live edits after the first cycle cross both ways within seconds,
//     and a delete propagates, while the device hub's forwardedCount
//     stays FLAT (only the direct socket carries the stream);
//   - A's serving list names the worktree and the caller while the
//     stream is up, and empties when the session is terminated, with
//     the serve child gone;
//   - the daemon's state stream reports the session in the app's
//     vocabulary (watching, both endpoints connected, cycles counted);
//   - stopping the daemon ends it and the gateway closes clean.
// Then the git follower (host/mirror/gitFollow.ts), driven against the
// same wire with B's worktree a real clone of A's repository:
//   - a commit on A lands on B: same tip, same branch, clean status;
//   - staging on A shows as staged on B, without touching files;
//   - a commit on B lands on A the same way (the push direction);
//   - commits on both sides since they agreed report diverged and move
//     nothing, and resolving on B brings the session back to synced;
//   - a checkout on A to a branch another worktree on B holds is
//     refused with the path, and checking back restores sync.
//
// Both "devices" share one node process and one sandboxed
// SHIGOMORI_ROOT; what separates them is the direct wire between them,
// which is exactly the surface this proof pins. Runs under
// scripts/lib/register-ts-alias.mjs. See package.json "mirror:check".
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildClient } from "@shared/ipc/buildClient";
import { forwardContract } from "@shared/ipc/modules/forward";
import { mirrorContract } from "@shared/ipc/modules/mirror";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { registerContract } from "@shared/ipc/registerContract";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { setFileSyncSpawnImpl, spawnStreamChild } from "@host/fileSync/spawn";
import { forwardHandlers, listMirrorServing } from "@host/ipc/modules/forward";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { createGitFollower } from "@host/mirror/gitFollow";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import { initShigomoriRootAt } from "@host/lib/util/paths";
import { createMirrorDaemon } from "../main/mirror/daemon.ts";
import { createMirrorGateway } from "../main/mirror/gateway.ts";
import { makeProof, makeTracker } from "./lib/checkKit.mjs";
import { bootDirectWire } from "./lib/directBoot.mjs";
import { delay, waitFor } from "./lib/hubBoot.mjs";

const execFileP = promisify(execFile);
const cliDir = join(import.meta.dirname, "..", "cli");
const fileSyncDir = join(import.meta.dirname, "..", "file-sync");

// Sandbox: everything (state root, repos, the built binary, the
// daemon's data) under one temp tree. realpath because worktree ids
// derive from git's resolved paths (/var/folders is a symlink on
// macOS).
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-mirror-check-")));
const stateRoot = join(sandbox, "root");
const smBinary = join(sandbox, "sm");
const fileSyncBinary = join(sandbox, "file-sync");
const fileSyncDataDir = join(sandbox, "file-sync-data");

// Scrub inherited GIT_* (a lefthook run exports GIT_DIR and would point
// fixture git at THIS repo) and pin idents.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});
const baseEnv = { ...process.env };
const smEnv = {
  ...baseEnv,
  SHIGOMORI_ROOT: stateRoot,
  // The fsevents binding's deprecation warning would otherwise land in
  // the build output on macOS 13+ (see scripts/build-cli.mjs).
  CGO_CFLAGS: "-Wno-deprecated-declarations",
};

async function git(cwd, args) {
  try {
    return await execFileP("git", args, { cwd, env: baseEnv });
  } catch (error) {
    // execFile's message is just "Command failed"; the reason is on
    // stderr.
    throw new Error(
      `git ${args.join(" ")} in ${cwd} failed: ${error.stderr || error.stdout || error.message}`,
      { cause: error },
    );
  }
}

async function gitOut(cwd, ...args) {
  const { stdout } = await git(cwd, args);
  return stdout.trim();
}

// The document-run seam the registered projects need (sm projects add),
// same NDJSON protocol as the Electron runner.
function runCli(args, onDoc) {
  return new Promise((resolve, reject) => {
    const child = spawnStreamChild(smBinary, ["--json", ...args], {
      env: smEnv,
    });
    const docs = [];
    let buffer = "";
    child.stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (
        let newline = buffer.indexOf("\n");
        newline >= 0;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const doc = JSON.parse(line);
          docs.push(doc);
          onDoc?.(doc);
        } catch {
          // Non-JSON stdout line; the assertions read docs only.
        }
      }
    });
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    child.stream.on("error", reject);
    child.onExit((code) => resolve({ code: code ?? -1, docs, stderrTail }));
  });
}

function cliFailureMessage(result, fallback) {
  const errorDoc = result.docs.find(
    (doc) => doc.ok === false && typeof doc.error === "string",
  );
  return errorDoc ? errorDoc.error : `${fallback} (CLI exit ${result.code})`;
}

async function sm(...args) {
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `sm ${args.join(" ")} failed: ${cliFailureMessage(result, "no error doc")}\n${result.stderrTail}`,
    );
  }
  return result;
}

// The shared waitFor tests a predicate's truthiness synchronously, so
// an async predicate (a Promise, always truthy) would pass at once. The
// git scenarios poll git, so they await.
async function waitUntil(predicate, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    if (await predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const read = (path) => readFileSync(path, "utf8");
const fileEquals = (path, want) => existsSync(path) && read(path) === want;

// A serve child spawned by A's handler, observed through the same seam
// production uses, so "no child spawned" and "child gone" are facts
// about real processes.
const serveChildren = new Set();
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const { ok, done, fail } = makeProof("mirror proof");

async function main() {
  console.log("mirror proof\n");

  // ---- Fixtures: build the CLI, seed A's repo and worktree, B's dir ----
  await Promise.all([
    execFileP("go", ["build", "-o", smBinary, "."], {
      cwd: cliDir,
      env: smEnv,
    }),
    execFileP("go", ["build", "-o", fileSyncBinary, "."], {
      cwd: fileSyncDir,
      env: smEnv,
    }),
  ]);

  const repoA = join(sandbox, "repo-a");
  await git(sandbox, ["init", "-q", "-b", "main", "repo-a"]);
  writeFileSync(join(repoA, "readme.txt"), "base\n");
  await git(repoA, ["add", "-A"]);
  await git(repoA, ["commit", "-qm", "base"]);
  const worktreeA = join(sandbox, "wt-a");
  await git(repoA, ["worktree", "add", "-q", "-b", "feature", worktreeA]);
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
  // same branch at the same tip: the state mirror:start leaves behind,
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

  initShigomoriRootAt(stateRoot);
  setCliRunnerImpl({
    runCli,
    requireCliBinary: () => smBinary,
    cliFailureMessage,
  });
  // A's serve children, exactly as the app spawns them, plus the
  // observation seam.
  setFileSyncSpawnImpl((args) =>
    spawnStreamChild(fileSyncBinary, args, {
      env: smEnv,
      onSpawned: (child) => serveChildren.add(child),
    }),
  );
  const projectIdOf = async (path) => {
    const result = await sm("projects", "add", "--", path);
    const doc = result.docs.findLast((d) => typeof d.id === "string");
    assert.ok(doc, `projects add emitted no project doc for ${path}`);
    return doc.id;
  };
  const projectIdA = await projectIdOf(repoA);
  const projectIdB = await projectIdOf(repoB);

  // ---- The direct wire: A serves the byte wire and its worktree list,
  // B dials through the real bridge cache. ----
  const { track, teardown } = makeTracker();
  const { stub, listener, peerA } = await bootDirectWire(track, {
    registerHandlers: (binding) => {
      registerContract(forwardContract, forwardHandlers, binding, {
        validateOutputs: true,
      });
      registerContract(worktreesContract, worktreesHandlers, binding, {
        validateOutputs: true,
        onUsageTracked: () => {},
      });
      // The git follower's peer half: the transfer verbs (both
      // directions) and the mirror's git state pair.
      registerContract(syncContract, syncHandlers, binding, {
        validateOutputs: true,
      });
      registerContract(mirrorContract, mirrorHandlers, binding, {
        validateOutputs: true,
      });
    },
  });
  const forwardOverWire = buildClient(forwardContract, peerA.transport);

  // B's half: the real gateway over the real peer client, the real
  // daemon on the freshly built binary.
  let changes = 0;
  const gateway = createMirrorGateway({
    peerApiFor: () => forwardOverWire,
    peerChannelsFor: () => peerA.channels,
    log: () => {},
  });
  const daemon = createMirrorDaemon({
    spawn: (args) =>
      spawnStreamChild(fileSyncBinary, args, {
        env: smEnv,
        onSpawned: (child) => track(() => child.kill("SIGKILL")),
      }),
    gatewayAddress: () => gateway.address(),
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

    const createInput = {
      localRoot: rootB,
      deviceId: "A",
      projectId: projectIdA,
      worktreeId: worktreeIdA,
      remoteRoot: worktreeA,
      name: "feature",
      labels: { localWorktreeId: worktreeIdB, localProjectId: projectIdB },
    };

    // (1) Ungranted: the gateway's openMirror is refused on A's wire, so
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
    assert.equal(serveChildren.size, 1);
    const [serveChild] = serveChildren;
    assert.ok(processAlive(serveChild.pid), "the serve child is not running");
    ok("A serves exactly one stream, attributed to worktree and caller");

    // (4) Live edits both ways, a delete, a nested create; the hub stays
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
    assert.ok(changes > 0, "the daemon never signalled a change");
    ok(
      "the state stream reports watching, both endpoints connected, cycles counted",
    );

    // ---- The git follower, against the same wire ----
    const follower = createGitFollower({
      sessions: () => daemon.sessions(),
      peerSyncApiFor: () => buildClient(syncContract, peerA.transport),
      peerMirrorApiFor: () => buildClient(mirrorContract, peerA.transport),
      sweepMs: 60_000,
      log: (message) => console.log(message),
    });
    track(() => follower.stop());
    const gitStatus = () => follower.statusOf(session);
    const waitGit = (status, what) =>
      waitUntil(() => gitStatus()?.status === status, what, 30_000);
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
    await waitUntil(
      async () => (await gitOut(rootB, "rev-parse", "HEAD")) === tipA1,
      "B's tip to follow A's commit",
      30_000,
    );
    assert.equal(
      await gitOut(rootB, "symbolic-ref", "HEAD"),
      "refs/heads/feature",
    );
    await waitUntil(
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
    await waitUntil(
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
    // B's own index watcher fires on the commit; the project ping is
    // what the local git-directory watcher would add.
    follower.onLocalProjectChanged(projectIdB);
    await waitUntil(
      async () => (await gitOut(worktreeA, "rev-parse", "HEAD")) === tipB1,
      "A's tip to follow B's commit",
      30_000,
    );
    await waitUntil(
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
    await waitUntil(
      async () => (await gitOut(rootB, "rev-parse", "HEAD")) === tipA2,
      "B to follow A once B's own commit is dropped",
      30_000,
    );
    await waitGit("synced", "synced after resolving the divergence");
    ok("git: dropping one side's commit lets the other side land again");

    // (G6) A branch collision: A checks out a branch that another
    // worktree on B already holds. Refused with the path, nothing
    // moves; checking back on A restores sync.
    const wtB2 = join(sandbox, "wt-b2");
    await git(repoB, ["worktree", "add", "-q", "-b", "other", wtB2]);
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
    // A serve child A spawned for the stream is tied to a conn the
    // idle sweep would only reap ten minutes later, and its stdio
    // would keep this process alive that long after a failure.
    for (const child of serveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await teardown();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

await main();
