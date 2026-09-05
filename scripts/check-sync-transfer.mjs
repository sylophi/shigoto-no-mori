// Durable proof for the device-sync transfer plumbing (direct-only): git bundles as chunked,
// grant-gated invoke responses over a REAL DIRECT websocket between the
// two fixtures, brokered by the stub device hub exactly as production
// does (scripts/lib/directBoot.mjs). Nothing here is a double on the
// sync path itself: device A registers the REAL sync contract and
// handlers on a real ticket-mode listener, the handlers shell the REAL
// sm binary (built from cli/ by this check), sm runs REAL git against
// fixture repos, and the receiver drives the REAL fetchBundleFromPeer
// helper through the real dialer and bridge cache. Asserts:
//   - an ungranted peer is refused (typed CommandRefusedError) and the
//     transfer surface never serves it;
//   - sync:captureDirty over the wire snapshots a dirty worktree to
//     its refs/shigomori/dirty/<id> ref;
//   - a >1.5 MB bundle (branch + dirty capture, thinned by a have)
//     crosses in >= 3 chunks and lands ONLY under refs/shigomori/ on
//     the receiver with the source's exact tips, byte-identical
//     content via git cat-file, and no branch materialized -- while
//     the stub device hub's forwardedCount stays FLAT (nothing but the
//     one-time broker frames ever rides the device hub);
//   - the host drops a finished transfer (a stale chunk request is
//     refused) and bundleAbort cleans up an abandoned one;
//   - unpacking a corrupted bundle fails with the coded "bad-bundle".
//
// The pull orchestration (slice C) and the transplant orchestration on
// top of it (step 9: pull plus source teardown over the peer's
// grant-gated worktrees:delete) run end to end below, against the same
// wire and the same real CLI.
//
// Both "devices" share one node process and one sandboxed
// SHIGOMORI_DATA_DIR holding two projects (source and target repos); what
// separates them is the direct wire between them, which is exactly the
// surface this proof pins. Runs under
// scripts/lib/register-ts-alias.mjs. See package.json "sync:check".
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  CommandRefusedError,
  WIRE_CHUNK_BYTES,
} from "@shared/ipc/socket/frames";
import { buildClient } from "@shared/ipc/buildClient";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { registerContract } from "@shared/ipc/registerContract";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { setPeerSyncApiImpl } from "@host/ipc/peerSync";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import {
  getRunningScriptWorktrees,
  killScriptsForWorktree,
  startScript,
} from "@host/lib/scripts";
import { fetchBundleFromPeer } from "@host/lib/sync/fetchBundle";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import { initDataDirAt } from "@host/lib/util/paths";
import {
  cliFailureMessage,
  createCliRunner,
  makeProof,
  makeTracker,
} from "./lib/checkKit.mjs";
import { bootDirectWire } from "./lib/directBoot.mjs";

const execFileP = promisify(execFile);
const cliDir = join(import.meta.dirname, "..", "cli");

// Sandbox: everything (data dir, repos, the built binary) under one
// temp tree. realpath because worktree ids derive from git's resolved
// paths (/var/folders is a symlink on macOS).
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-sync-check-")));
const dataDir = join(sandbox, "data");
const smBinary = join(sandbox, "sm");

// Scrub inherited GIT_* (a lefthook run exports GIT_DIR and would point
// fixture git at THIS repo) and pin idents so commit-tree in `sm dirty
// capture` never depends on the machine's git config. Mutated on
// process.env itself (not just a filtered copy): the slice-C pull
// orchestration drives the app's OWN git layer (host/lib/git/core),
// which spawns git with process.env.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});
const baseEnv = { ...process.env };
const smEnv = { ...baseEnv, SHIGOMORI_DATA_DIR: dataDir };

async function git(cwd, args, opts = {}) {
  return execFileP("git", args, {
    cwd,
    env: baseEnv,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
}

async function gitOut(cwd, ...args) {
  const { stdout } = await git(cwd, args);
  return stdout.trim();
}

async function refExists(repo, ref) {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

// Every ref in a repo as a Set of "refname sha" lines. The transfer
// proof snapshots this before and after unpack and asserts the delta is
// EXACTLY the wanted refs -- a stray refs/tags/* (git's tag auto-follow,
// the M1 hole) would show up here as an unexpected extra line.
async function refSnapshot(repo) {
  const out = await gitOut(
    repo,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  );
  return new Set(out ? out.split("\n") : []);
}

// The real CLI runner seam (scripts/lib/checkKit.mjs): the same
// NDJSON-per-line protocol as the Electron implementation, minus the
// child bookkeeping the app needs.
const { runCli, sm } = createCliRunner(smBinary, smEnv);

const { ok, done, fail } = makeProof("sync-transfer proof");

async function main() {
  console.log("sync-transfer proof\n");

  // ---- Fixtures: build the CLI, seed repos, register projects ----
  await execFileP("go", ["build", "-o", smBinary, "."], {
    cwd: cliDir,
    env: baseEnv,
  });

  // Source repo: base commit on main, a "feature" branch carrying
  // ~1.7 MB of incompressible bytes (so the thin bundle still crosses
  // in >= 3 chunks), a linked worktree for the dirty capture.
  const sourceRepo = join(sandbox, "source");
  await git(sandbox, ["init", "-q", "-b", "main", "source"]);
  for (const args of [
    ["config", "gc.auto", "0"],
    ["config", "maintenance.auto", "false"],
    ["commit", "-q", "--allow-empty", "-m", "init"],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- repo setup is ordered
    await git(sourceRepo, args);
  }
  writeFileSync(join(sourceRepo, "readme.txt"), "base\n");
  await git(sourceRepo, ["add", "-A"]);
  await git(sourceRepo, ["commit", "-qm", "base"]);
  const baseSha = await gitOut(sourceRepo, "rev-parse", "HEAD");

  // Target repo: a clone holding only the base history -- the
  // receiving device's copy of the same project.
  const targetRepo = join(sandbox, "target");
  await git(sandbox, ["clone", "-q", "--", sourceRepo, "target"]);
  await git(targetRepo, ["config", "gc.auto", "0"]);
  await git(targetRepo, ["config", "maintenance.auto", "false"]);

  await git(sourceRepo, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(sourceRepo, "big.bin"), randomBytes(1_700_000));
  await git(sourceRepo, ["add", "-A"]);
  await git(sourceRepo, ["commit", "-qm", "big feature"]);
  const featureTip = await gitOut(sourceRepo, "rev-parse", "HEAD");
  await git(sourceRepo, ["checkout", "-q", "main"]);

  const worktreePath = join(sandbox, "wt");
  await git(sourceRepo, [
    "worktree",
    "add",
    "-q",
    "-b",
    "scratch",
    worktreePath,
  ]);
  // A second worktree whose branch carries a commit the target has
  // never seen, for the pull proof's branch-transfer path (scratch sits
  // at the shared base commit, exercising the tip-already-local path).
  const worktree2Path = join(sandbox, "wt2");
  await git(sourceRepo, [
    "worktree",
    "add",
    "-q",
    "-b",
    "feature2",
    worktree2Path,
  ]);
  writeFileSync(join(worktree2Path, "second.txt"), "second feature\n");
  await git(worktree2Path, ["add", "-A"]);
  await git(worktree2Path, ["commit", "-qm", "second feature"]);
  const feature2Tip = await gitOut(worktree2Path, "rev-parse", "HEAD");
  // The real app derivation (host/lib/git/worktrees.ts, Go twin in
  // cli/worktree.go), imported straight from its home now that
  // tsAliasLoader handles the transitive JSON import. The capture ref
  // must land at refs/shigomori/dirty/<this id>, asserted below.
  const worktreeId = worktreeIdFromPath(worktreePath);

  initDataDirAt(dataDir);
  setCliRunnerImpl({
    runCli,
    requireCliBinary: () => smBinary,
    cliFailureMessage,
  });
  const projectIdOf = async (path) => {
    const result = await sm("projects", "add", "--", path);
    const doc = result.docs.findLast((d) => typeof d.id === "string");
    assert.ok(doc, `projects add emitted no project doc for ${path}`);
    return doc.id;
  };
  // Target first: both fixture projects share one registry AND one repo
  // identity (target is a clone), and the pull handler's identity scan
  // takes the first registry match -- which must be the pull's local
  // target for the round-trip proof below.
  const targetProjectId = await projectIdOf(targetRepo);
  const sourceProjectId = await projectIdOf(sourceRepo);

  // ---- The direct wire: A hosts the real sync surface on a real
  // ticket-mode listener, B receives through the real dialer and
  // bridge cache, with the stub device hub carrying ONLY the broker
  // exchange (bootDirectWire, the shared fixture). Teardowns collect
  // on the shared tracker for the finally below.
  const { track, teardown } = makeTracker();
  const { stub, listener, peerA } = await bootDirectWire(track, {
    registerHandlers: (binding) => {
      registerContract(syncContract, syncHandlers, binding, {
        validateOutputs: true,
      });
      // The teardown half of the transplant proof: the REAL worktrees
      // surface on A's wire, beside the sync surface. The usage hook is
      // the Electron binding's concern, so a no-op satisfies the
      // registrar.
      registerContract(worktreesContract, worktreesHandlers, binding, {
        validateOutputs: true,
        onUsageTracked: () => {},
      });
    },
  });
  try {
    const sync = buildClient(syncContract, peerA.transport);
    const worktreesOverWire = buildClient(worktreesContract, peerA.transport);
    const dirtyRef = `refs/shigomori/dirty/${worktreeId}`;

    // (1) Ungranted: the whole surface is refused typed, before any
    // handler runs -- fetchBundleFromPeer fails on its first call.
    await assert.rejects(
      () =>
        fetchBundleFromPeer(sync, {
          sourceProjectId,
          targetProjectId,
          refs: ["refs/heads/feature"],
          haves: [],
        }),
      (error) =>
        error instanceof CommandRefusedError &&
        /not permitted to run commands/.test(error.message),
    );
    await assert.rejects(
      () => sync.captureDirty({ projectId: sourceProjectId, worktreeId }),
      (error) => error instanceof CommandRefusedError,
    );
    // The transplant teardown rides the same gate: worktrees:delete over
    // the wire is refused typed for an ungranted peer too.
    await assert.rejects(
      () =>
        worktreesOverWire.delete({ projectId: sourceProjectId, worktreeId }),
      (error) => error instanceof CommandRefusedError,
    );
    ok(
      "ungranted peer: bundleStart, captureDirty and worktrees:delete are refused with the typed CommandRefusedError",
    );

    listener.setAccepts(true);

    // (2) captureDirty over the wire: a dirty worktree snapshots to
    // its capture ref on the host, tip echoed back.
    writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted work\n");
    const capture = await sync.captureDirty({
      projectId: sourceProjectId,
      worktreeId,
    });
    assert.equal(capture.captured, true, "capture reported clean");
    const captureTip = await gitOut(sourceRepo, "rev-parse", dirtyRef);
    assert.equal(capture.commit, captureTip);
    ok("captureDirty over the wire snapshots the worktree to its capture ref");

    // (3) The full transfer: branch + capture ref, thinned by the
    // receiver's base tip, >= 3 chunks, exact tips, allowed namespaces
    // only, byte-identical objects. The direct session is established
    // by now (the refusals above dialed it), so the device hub must
    // stay COMPLETELY flat for the whole transfer: no frame of it may
    // ride the stub.
    const hubBaseline = stub.forwardedCount();
    const chunksBefore = peerA.invokeCount("sync:bundleChunk");
    const refsBefore = await refSnapshot(targetRepo);
    const { fetched } = await fetchBundleFromPeer(sync, {
      sourceProjectId,
      targetProjectId,
      refs: ["refs/heads/feature", dirtyRef],
      haves: [baseSha],
    });
    const chunkReqs = peerA.invokeCount("sync:bundleChunk") - chunksBefore;
    assert.ok(
      chunkReqs >= 3,
      `expected >= 3 chunks for a >1.5 MB bundle, saw ${chunkReqs}`,
    );
    assert.equal(
      stub.forwardedCount(),
      hubBaseline,
      "the bundle transfer rode the device hub instead of the direct socket",
    );
    const wantTips = {
      "refs/shigomori/incoming/feature": featureTip,
      [dirtyRef]: captureTip,
    };
    assert.deepEqual(
      Object.fromEntries(fetched.map(({ ref, commit }) => [ref, commit])),
      wantTips,
    );
    for (const [ref, tip] of Object.entries(wantTips)) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of git probes
      assert.equal(await gitOut(targetRepo, "rev-parse", "--verify", ref), tip);
    }
    let branchMaterialized = true;
    try {
      await git(targetRepo, ["rev-parse", "--verify", "refs/heads/feature"]);
    } catch {
      branchMaterialized = false;
    }
    assert.equal(
      branchMaterialized,
      false,
      "the transfer materialized a branch on the receiver",
    );
    // The ref set grew by EXACTLY the wanted refs and nothing else: no
    // stray refs/tags/* auto-followed, no ref outside refs/shigomori/.
    const refsAfter = await refSnapshot(targetRepo);
    const appeared = [...refsAfter].filter((line) => !refsBefore.has(line));
    assert.deepEqual(
      new Set(appeared),
      new Set([
        `refs/shigomori/incoming/feature ${featureTip}`,
        `${dirtyRef} ${captureTip}`,
      ]),
      `unpack changed refs beyond the wanted set: ${appeared.join(", ")}`,
    );
    const blob = (repo) =>
      git(repo, ["cat-file", "blob", `${featureTip}:big.bin`], {
        encoding: "buffer",
      });
    const [{ stdout: sourceBlob }, { stdout: targetBlob }] = await Promise.all([
      blob(sourceRepo),
      blob(targetRepo),
    ]);
    assert.equal(sourceBlob.length, 1_700_000);
    assert.ok(
      Buffer.compare(sourceBlob, targetBlob) === 0,
      "transferred blob differs byte-for-byte",
    );
    ok(
      "granted transfer: >1.5 MB bundle crosses in >= 3 chunks and lands only under refs/shigomori/ with byte-identical objects",
    );

    // (4) Transfer lifecycle: eof drops the host entry (a stale chunk
    // is refused), abort drops an abandoned one.
    const manual = await sync.bundleStart({
      projectId: sourceProjectId,
      refs: ["refs/heads/feature"],
      haves: [baseSha],
    });
    assert.ok(
      manual.bytes > 1_500_000,
      `thin bundle unexpectedly small: ${manual.bytes} bytes`,
    );
    const firstChunk = await sync.bundleChunk({
      transferId: manual.transferId,
      offset: 0,
    });
    assert.equal(firstChunk.eof, false);
    assert.equal(
      Buffer.from(firstChunk.dataB64, "base64").length,
      WIRE_CHUNK_BYTES,
    );
    await sync.bundleAbort({ transferId: manual.transferId });
    await assert.rejects(
      () => sync.bundleChunk({ transferId: manual.transferId, offset: 0 }),
      /unknown-transfer/,
    );
    // Idempotent abort: a second abort (or one for a finished
    // transfer) is a no-op, never a failure.
    await sync.bundleAbort({ transferId: manual.transferId });
    ok(
      "lifecycle: a chunk is WIRE_CHUNK_BYTES raw, abort drops the transfer, and a stale transferId is refused",
    );

    // (5) A corrupted bundle refuses with the coded kind, straight from
    // the CLI's json error document.
    const corrupt = join(sandbox, "corrupt.bundle");
    writeFileSync(corrupt, randomBytes(4096));
    const result = await runCli([
      "bundle",
      "unpack",
      "--project-id",
      targetProjectId,
      "--in",
      corrupt,
      "--refspec",
      "refs/heads/feature:refs/shigomori/incoming/feature",
    ]);
    assert.notEqual(result.code, 0);
    const errorDoc = result.docs.find((doc) => doc.ok === false);
    assert.equal(errorDoc?.code, "bad-bundle");
    ok('corrupted bundle: unpack fails with the coded "bad-bundle" error');

    // ---- The slice-C pull orchestration, end to end. The handler runs
    // HERE as device B (the registered surface above is A's), with its
    // two real seams injected: the CLI runner (already set) and the
    // peer sync api, which is the SAME direct-wire client the transfer
    // tests drove. Everything in between -- refTips negotiation,
    // captureDirty, the chunked bundle, `sm create`, the capture
    // re-key, `sm dirty apply` -- is production code against real git.
    setPeerSyncApiImpl({
      syncApiFor: (deviceId) => {
        assert.equal(deviceId, "A", "the pull dialed an unexpected device");
        return sync;
      },
      // The transplant teardown's reach, over the same direct wire.
      worktreesApiFor: (deviceId) => {
        assert.equal(deviceId, "A", "the teardown dialed an unexpected device");
        return worktreesOverWire;
      },
    });
    const pullCtx = {
      signal: new AbortController().signal,
      notifier: () => () => {},
    };
    // The transplant as the dialog drives it: the pull, then the
    // teardown reading the pull's own receipt.
    const transplant = async (input) => {
      const pulled = await syncHandlers.pullWorktree(input, pullCtx);
      const torn = await syncHandlers.teardownSource(
        {
          sourceDeviceId: input.sourceDeviceId,
          sourceProjectId: input.sourceProjectId,
          sourceWorktreeId: input.sourceWorktreeId,
        },
        pullCtx,
      );
      return { ...pulled, ...torn };
    };
    const identity = await getRepoIdentity(sourceRepo);
    assert.ok(identity, "fixture repos should carry a non-null identity");
    assert.equal(
      identity,
      await getRepoIdentity(targetRepo),
      "clone and source must share a repo identity",
    );

    // (6) Branch-transfer path: a clean worktree on a branch whose tip
    // the receiver lacks. The branch crosses as a thin bundle, the
    // worktree lands on it, and the incoming ref is swept.
    const cleanPull = await syncHandlers.pullWorktree(
      {
        sourceDeviceId: "A",
        sourceProjectId,
        sourceWorktreeId: worktreeIdFromPath(worktree2Path),
        sourceIdentity: identity,
        branch: "feature2",
      },
      pullCtx,
    );
    assert.equal(cleanPull.dirtyApplied, false);
    assert.equal(cleanPull.worktree.branch, "feature2");
    assert.equal(
      await gitOut(cleanPull.worktree.path, "rev-parse", "HEAD"),
      feature2Tip,
    );
    assert.equal(
      await gitOut(cleanPull.worktree.path, "status", "--porcelain"),
      "",
      "a clean pull must land a clean worktree",
    );
    assert.equal(
      await refExists(targetRepo, "refs/shigomori/incoming/feature2"),
      false,
      "the incoming ref must be swept after a successful pull",
    );
    ok(
      "pull round trip (clean): the branch crosses the direct wire and the worktree lands on it with the incoming ref swept",
    );

    // (7) Dirty + tip-already-local path: scratch sits at the base
    // commit the receiver already holds, so no branch bundle crosses;
    // the fresh capture does, gets re-keyed from the source worktree id
    // to the new local one, and lands unstaged.
    const dirtyPull = await syncHandlers.pullWorktree(
      {
        sourceDeviceId: "A",
        sourceProjectId,
        sourceWorktreeId: worktreeId,
        sourceIdentity: identity,
        branch: "scratch",
      },
      pullCtx,
    );
    assert.equal(dirtyPull.dirtyApplied, true);
    assert.equal(dirtyPull.worktree.branch, "scratch");
    assert.equal(
      await gitOut(dirtyPull.worktree.path, "rev-parse", "HEAD"),
      baseSha,
    );
    assert.equal(
      readFileSync(join(dirtyPull.worktree.path, "dirty.txt"), "utf8"),
      "uncommitted work\n",
    );
    // Restored UNSTAGED, exactly as `sm dirty apply` flattens it.
    assert.match(
      await gitOut(dirtyPull.worktree.path, "status", "--porcelain"),
      /^\?\? dirty\.txt$/m,
    );
    // Consumed and swept: the source-keyed capture ref, the re-keyed
    // local one, and the landing ref are all gone.
    for (const ref of [
      dirtyRef,
      `refs/shigomori/dirty/${dirtyPull.worktree.id}`,
      "refs/shigomori/incoming/scratch",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of git probes
      const survived = await refExists(targetRepo, ref);
      assert.equal(survived, false, `${ref} survived the pull`);
    }
    ok(
      "pull round trip (dirty): no branch bundle for a locally-known tip, and the capture is re-keyed, applied unstaged, and consumed",
    );

    // (8) The update-existing case is out of scope by design: a second
    // pull of the same branch refuses up front with the actionable
    // message, before touching the peer.
    await assert.rejects(
      () =>
        syncHandlers.pullWorktree(
          {
            sourceDeviceId: "A",
            sourceProjectId,
            sourceWorktreeId: worktreeId,
            sourceIdentity: identity,
            branch: "scratch",
          },
          pullCtx,
        ),
      /is already checked out at .* on this device/,
    );
    // And an identity nothing local matches is refused before anything
    // else runs.
    await assert.rejects(
      () =>
        syncHandlers.pullWorktree(
          {
            sourceDeviceId: "A",
            sourceProjectId,
            sourceWorktreeId: worktreeId,
            sourceIdentity: "root:0000000000000000000000000000000000000000",
            branch: "scratch-two",
          },
          pullCtx,
        ),
      /No local project matches/,
    );
    ok(
      "pull refusals: an already-existing branch and an unmatched repo identity both refuse up front",
    );

    // ---- The transplant (step 9): the pull above plus tearing the
    // source worktree down on A through its wire-served
    // worktrees:delete, gated by the pull's receipt. Fresh worktrees
    // per scenario, since the earlier tests consumed wt and wt2.

    // (9) Clean transplant: the branch crosses, the worktree lands, and
    // the SOURCE side loses the worktree directory, its sm worktree
    // data, and the branch. A MANAGED worktree (sm create, the realistic
    // transplant source): `sm rm` only deletes the branch for managed
    // worktrees, and the sandbox's unset DeleteBranchOnRemove defaults
    // to delete (cli/cmd_rm.go).
    const wt3Create = await sm(
      "create",
      "--project-id",
      sourceProjectId,
      "--branch",
      "feature3",
    );
    const wt3Doc = wt3Create.docs.find((doc) => doc.event === "created");
    assert.ok(wt3Doc, "sm create emitted no created doc");
    const wt3Path = wt3Doc.worktree.path;
    const wt3Id = wt3Doc.worktree.id;
    writeFileSync(join(wt3Path, "third.txt"), "third feature\n");
    await git(wt3Path, ["add", "-A"]);
    await git(wt3Path, ["commit", "-qm", "third feature"]);
    const feature3Tip = await gitOut(wt3Path, "rev-parse", "HEAD");
    // Seed the app-written per-worktree data file (the CLI only ever
    // deletes it), so the teardown's state sweep is observable.
    const wt3DataPath = join(
      dataDir,
      "projects",
      sourceProjectId,
      "worktrees",
      `${wt3Id}.json`,
    );
    mkdirSync(dirname(wt3DataPath), { recursive: true });
    writeFileSync(wt3DataPath, "{}\n");
    const cleanTransplant = await transplant({
      sourceDeviceId: "A",
      sourceProjectId,
      sourceWorktreeId: wt3Id,
      sourceIdentity: identity,
      branch: "feature3",
    });
    assert.equal(cleanTransplant.sourceRemoved, true);
    assert.equal(cleanTransplant.sourceError, undefined);
    assert.equal(cleanTransplant.dirtyApplied, false);
    assert.equal(cleanTransplant.worktree.branch, "feature3");
    assert.equal(
      await gitOut(cleanTransplant.worktree.path, "rev-parse", "HEAD"),
      feature3Tip,
    );
    assert.equal(
      await gitOut(cleanTransplant.worktree.path, "status", "--porcelain"),
      "",
      "a clean transplant must land a clean worktree",
    );
    assert.equal(
      existsSync(wt3Path),
      false,
      "the source worktree directory must be gone",
    );
    assert.equal(
      existsSync(wt3DataPath),
      false,
      "the source sm worktree data must be gone",
    );
    assert.equal(
      await refExists(sourceRepo, "refs/heads/feature3"),
      false,
      "the source branch must be deleted (DeleteBranchOnRemove default)",
    );
    ok(
      "transplant (clean): the worktree lands here and the source worktree, its sm data, and its branch are torn down",
    );

    // (10) Dirty transplant: staged + unstaged + untracked dirt on the
    // source. The capture lands here applied, and the teardown's
    // captured-driven force removes the (legitimately still dirty)
    // source anyway.
    const wt4Path = join(sandbox, "wt4");
    await git(sourceRepo, ["worktree", "add", "-q", "-b", "feature4", wt4Path]);
    writeFileSync(join(wt4Path, "committed.txt"), "committed\n");
    await git(wt4Path, ["add", "-A"]);
    await git(wt4Path, ["commit", "-qm", "fourth feature"]);
    writeFileSync(join(wt4Path, "staged.txt"), "staged\n");
    await git(wt4Path, ["add", "staged.txt"]);
    writeFileSync(join(wt4Path, "committed.txt"), "committed, then edited\n");
    writeFileSync(join(wt4Path, "untracked.txt"), "untracked\n");
    const dirtyTransplant = await transplant({
      sourceDeviceId: "A",
      sourceProjectId,
      sourceWorktreeId: worktreeIdFromPath(wt4Path),
      sourceIdentity: identity,
      branch: "feature4",
    });
    assert.equal(dirtyTransplant.captured, true);
    assert.equal(dirtyTransplant.dirtyApplied, true);
    assert.equal(dirtyTransplant.sourceRemoved, true);
    for (const [file, content] of [
      ["staged.txt", "staged\n"],
      ["committed.txt", "committed, then edited\n"],
      ["untracked.txt", "untracked\n"],
    ]) {
      assert.equal(
        readFileSync(join(dirtyTransplant.worktree.path, file), "utf8"),
        content,
      );
    }
    assert.equal(
      existsSync(wt4Path),
      false,
      "the dirty source worktree must be gone (the teardown's force path)",
    );
    ok(
      "transplant (dirty): the capture lands applied and force removes the still-dirty source worktree",
    );

    // (11) Scripts-running refusal: a live script in the source worktree
    // makes the teardown refuse (never kill), so the pull half succeeds
    // and the source survives with the worktree on both sides.
    const wt5Path = join(sandbox, "wt5");
    await git(sourceRepo, ["worktree", "add", "-q", "-b", "feature5", wt5Path]);
    const wt5Id = worktreeIdFromPath(wt5Path);
    // A REAL long-lived script through the app's registry (the registry
    // is what the refusal flag consults), reaped in the finally below.
    startScript({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      scriptName: "sleep",
      worktree: { id: wt5Id, name: "wt5", branch: "feature5", path: wt5Path },
      project: { id: sourceProjectId, path: sourceRepo, name: "source" },
      projectBranch: "main",
      defaultBranch: "main",
      notify: () => {},
    });
    try {
      const refusedTransplant = await transplant({
        sourceDeviceId: "A",
        sourceProjectId,
        sourceWorktreeId: wt5Id,
        sourceIdentity: identity,
        branch: "feature5",
      });
      assert.equal(refusedTransplant.worktree.branch, "feature5");
      assert.equal(
        existsSync(refusedTransplant.worktree.path),
        true,
        "the pull half must still land the worktree here",
      );
      assert.equal(refusedTransplant.sourceRemoved, false);
      assert.match(
        refusedTransplant.sourceError ?? "",
        /scripts-running/,
        "the refusal must carry the stable scripts-running marker",
      );
      assert.equal(
        existsSync(wt5Path),
        true,
        "the source worktree must survive a refused teardown",
      );
      assert.equal(
        getRunningScriptWorktrees().some((w) => w.worktreeId === wt5Id),
        true,
        "the refused teardown must leave the source's scripts running",
      );
    } finally {
      await killScriptsForWorktree(wt5Id);
    }
    ok(
      "transplant (scripts running): the teardown refuses with the scripts-running marker and the source survives",
    );

    // (12) The receipt gate: a teardown for a worktree this device never
    // pulled refuses before dialing the peer. A receipt serves exactly
    // one successful teardown. A source that changed after the pull
    // (edits after the capture, or a moved tip) keeps its copy until it
    // matches the receipt again.
    await assert.rejects(
      syncHandlers.teardownSource(
        {
          sourceDeviceId: "A",
          sourceProjectId,
          sourceWorktreeId: "0123456789ab",
        },
        pullCtx,
      ),
      /No pull recorded/,
    );
    await assert.rejects(
      syncHandlers.teardownSource(
        { sourceDeviceId: "A", sourceProjectId, sourceWorktreeId: wt3Id },
        pullCtx,
      ),
      /No pull recorded/,
    );
    const wt6Path = join(sandbox, "wt6");
    await git(sourceRepo, ["worktree", "add", "-q", "-b", "feature6", wt6Path]);
    writeFileSync(join(wt6Path, "sixth.txt"), "sixth\n");
    await git(wt6Path, ["add", "-A"]);
    await git(wt6Path, ["commit", "-qm", "sixth feature"]);
    writeFileSync(join(wt6Path, "draft.txt"), "draft\n");
    const wt6Id = worktreeIdFromPath(wt6Path);
    const wt6Source = {
      sourceDeviceId: "A",
      sourceProjectId,
      sourceWorktreeId: wt6Id,
    };
    const latePull = await syncHandlers.pullWorktree(
      { ...wt6Source, sourceIdentity: identity, branch: "feature6" },
      pullCtx,
    );
    assert.equal(latePull.captured, true);
    assert.equal(latePull.dirtyApplied, true);
    // The user takes their time. Meanwhile something edits the source.
    writeFileSync(join(wt6Path, "draft.txt"), "draft, then edited\n");
    const refusedLate = await syncHandlers.teardownSource(wt6Source, pullCtx);
    assert.equal(refusedLate.sourceRemoved, false);
    assert.match(refusedLate.sourceError ?? "", /changed after/);
    assert.equal(existsSync(wt6Path), true, "a changed source must survive");
    // Back to exactly the captured state, the receipt matches again.
    writeFileSync(join(wt6Path, "draft.txt"), "draft\n");
    const lateTeardown = await syncHandlers.teardownSource(wt6Source, pullCtx);
    assert.equal(lateTeardown.sourceRemoved, true, lateTeardown.sourceError);
    assert.equal(existsSync(wt6Path), false);
    ok(
      "teardownSource: refuses without a receipt, refuses a source that changed after the pull, and removes it once it matches again",
    );
  } finally {
    // Reverse creation order via the shared tracker: the direct
    // sessions and listener first, then the hub connections, then
    // the stub.
    await teardown();
  }

  done();
}

main()
  .catch(fail)
  .finally(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });
