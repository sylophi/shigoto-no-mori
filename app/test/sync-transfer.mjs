// Durable proof for the device-sync transfer plumbing (direct-only): git bundles as chunked,
// grant-gated invoke responses over a REAL DIRECT websocket between the
// two fixtures, brokered by the stub device hub exactly as production
// does (test/lib/directBoot.mjs). Nothing here is a double on the
// sync path itself: device A registers the REAL sync contract and
// handlers on a real direct listener, the handlers shell the REAL
// sm binary (built from cli/ by this check), sm runs REAL git against
// fixture repos, and the receiver drives the REAL fetchBundleFromPeer
// helper through the real dialer and bridge cache. Asserts:
//   - an ungranted peer is refused (typed CommandRefusedError) and the
//     transfer surface never serves it;
//   - sync:captureDirty over the wire snapshots a dirty worktree to
//     its refs/shigomori/dirty/<id> ref, and sync:ignoredPaths names
//     the ignored file that capture leaves out;
//   - a >2.5 MB bundle (branch + dirty capture, thinned by a have)
//     crosses in >= 4 chunks (windowed, the final one last) and lands
//     ONLY under refs/shigomori/ on the receiver with the source's
//     exact tips, byte-identical content via git cat-file, and no
//     branch materialized -- while the stub device hub's
//     forwardedCount stays FLAT (nothing but the one-time broker
//     frames ever rides the device hub);
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
// test/lib/register-ts-alias.mjs. Run: pnpm test sync-transfer.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CommandRefusedError,
  WIRE_CHUNK_BYTES,
} from "@shared/ipc/socket/frames";
import { buildClient } from "@shared/ipc/buildClient";
import { projectsContract } from "@shared/ipc/modules/projects";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { setPeerSyncApiImpl } from "@host/ipc/peerSync";
import { projectsHandlers } from "@host/ipc/modules/projects";
import {
  runPullWorktree,
  sendWorktree,
  syncHandlers,
} from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import {
  getRunningScriptWorktrees,
  killScriptsForWorktree,
  startScript,
} from "@host/lib/scripts";
import { cloneProjectFromPeer } from "@host/lib/sync/cloneFromPeer";
import { fetchBundleFromPeer } from "@host/lib/sync/fetchBundle";
import { pushBundleToPeer } from "@host/lib/sync/pushBundle";
import { findProjectOrThrow, listProjects } from "@host/lib/projects";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import { makeProof, makeTracker } from "./lib/checkKit.mjs";
import { cliSandbox } from "./lib/cliSandbox.mjs";
import { bootDirectWire } from "./lib/directBoot.mjs";

// The sandbox, the scrubbed process.env with pinned idents, the git
// wrappers and the real CLI runner seam (test/lib/cliSandbox.mjs).
const fixture = cliSandbox("sm-sync-check-");
const { sandbox, dataDir, git, gitOut, runCli, sm } = fixture;
const { commitFile, addWorktree } = fixture;

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

const { ok, done, fail } = makeProof("sync-transfer proof");

// A peer whose chunk calls (bundleChunk or pushChunk) are counted: how
// many were in flight at once, the offsets in the order they were
// sent, and how many others were in flight when the eof chunk was
// asked for.
function observedChunks(peer, method) {
  const seen = { inFlight: 0, most: 0, offsets: [], othersAtEof: null };
  return {
    seen,
    peer: {
      ...peer,
      [method]: async (input) => {
        seen.offsets.push(input.offset);
        seen.inFlight += 1;
        seen.most = Math.max(seen.most, seen.inFlight);
        const others = seen.inFlight - 1;
        try {
          const result = await peer[method](input);
          if (result?.eof) seen.othersAtEof = others;
          return result;
        } finally {
          seen.inFlight -= 1;
        }
      },
    },
  };
}

async function main() {
  console.log("sync-transfer proof\n");

  // ---- Fixtures: build the CLI, seed repos, register projects ----
  await fixture.buildSm();

  // Source repo: base commit on main, a "feature" branch carrying
  // ~2.7 MB of incompressible bytes (so the thin bundle still crosses
  // in >= 4 chunks), a linked worktree for the dirty capture.
  const sourceRepo = join(sandbox, "source");
  await git(sandbox, ["init", "-q", "-b", "main", "source"]);
  await fixture.disableAutoGc(sourceRepo);
  await git(sourceRepo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  await commitFile(sourceRepo, "readme.txt", "base\n", "base");
  const baseSha = await gitOut(sourceRepo, "rev-parse", "HEAD");

  // Target repo: a clone holding only the base history -- the
  // receiving device's copy of the same project.
  const targetRepo = join(sandbox, "target");
  await git(sandbox, ["clone", "-q", "--", sourceRepo, "target"]);
  await fixture.disableAutoGc(targetRepo);

  await git(sourceRepo, ["checkout", "-q", "-b", "feature"]);
  await commitFile(
    sourceRepo,
    "big.bin",
    randomBytes(2_700_000),
    "big feature",
  );
  const featureTip = await gitOut(sourceRepo, "rev-parse", "HEAD");
  await git(sourceRepo, ["checkout", "-q", "main"]);

  const worktreePath = await addWorktree(sourceRepo, "wt", "scratch");
  // A second worktree whose branch carries a commit the target has
  // never seen, for the pull proof's branch-transfer path (scratch sits
  // at the shared base commit, exercising the tip-already-local path).
  const worktree2Path = await addWorktree(
    sourceRepo,
    "wt2",
    "feature2",
    "second.txt",
    "second feature\n",
    "second feature",
  );
  const feature2Tip = await gitOut(worktree2Path, "rev-parse", "HEAD");
  // The real app derivation (host/lib/git/worktrees.ts, Go twin in
  // cli/worktree.go), imported straight from its home now that
  // tsAliasLoader handles the transitive JSON import. The capture ref
  // must land at refs/shigomori/dirty/<this id>, asserted below.
  const worktreeId = worktreeIdFromPath(worktreePath);

  fixture.useCli();
  const { projectIdOf } = fixture;
  // Target first: both fixture projects share one registry AND one repo
  // identity (target is a clone), and the pull handler's identity scan
  // takes the first registry match -- which must be the pull's local
  // target for the round-trip proof below.
  const targetProjectId = await projectIdOf(targetRepo);
  const sourceProjectId = await projectIdOf(sourceRepo);

  // ---- The direct wire: A hosts the real sync surface on a real
  // listener, B receives through the real dialer and
  // bridge cache, with the stub device hub carrying ONLY the broker
  // exchange (bootDirectWire, the shared fixture). Teardowns collect
  // on the shared tracker for the finally below.
  const { track, teardown } = makeTracker();
  const { stub, listener, peerA } = await bootDirectWire(track, {
    contracts: [
      [syncContract, syncHandlers],
      // The teardown half of the transplant proof: the REAL worktrees
      // surface on A's wire, beside the sync surface. The usage hook is
      // the Electron binding's concern, so a no-op satisfies the
      // registrar.
      [worktreesContract, worktreesHandlers],
      // The clone's one read of the peer (its default branch), beside
      // the grant-gated bundle it then asks for.
      [projectsContract, projectsHandlers],
    ],
  });
  try {
    const sync = buildClient(syncContract, peerA.transport);
    const worktreesOverWire = buildClient(worktreesContract, peerA.transport);
    const projectsOverWire = buildClient(projectsContract, peerA.transport);
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
    // its capture ref on the host, tip echoed back. An ignored file
    // sits beside the dirt: the capture has `git add -A` semantics, so
    // it must stay out of the capture and be named by ignoredPaths,
    // which is how the transplant dialog says what a teardown takes.
    writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted work\n");
    writeFileSync(join(worktreePath, ".gitignore"), "secret.env\n");
    writeFileSync(join(worktreePath, "secret.env"), "FIXTURE_ONLY=1\n");
    const capture = await sync.captureDirty({
      projectId: sourceProjectId,
      worktreeId,
    });
    assert.equal(capture.captured, true, "capture reported clean");
    const captureTip = await gitOut(sourceRepo, "rev-parse", dirtyRef);
    assert.equal(capture.commit, captureTip);
    const captured = await gitOut(
      sourceRepo,
      "ls-tree",
      "-r",
      "--name-only",
      captureTip,
    );
    assert.ok(captured.includes("dirty.txt"), "the dirt is captured");
    assert.ok(!captured.includes("secret.env"), "the ignored file is not");
    const ignored = await sync.ignoredPaths({
      projectId: sourceProjectId,
      worktreeId,
    });
    assert.deepEqual(ignored, {
      paths: ["secret.env"],
      patterns: ["secret.env"],
      total: 1,
    });
    ok(
      "captureDirty over the wire snapshots the worktree to its capture ref, and ignoredPaths names the file it leaves out",
    );

    // (3) The full transfer: branch + capture ref, thinned by the
    // receiver's base tip, >= 4 chunks, exact tips, allowed namespaces
    // only, byte-identical objects. The direct session is established
    // by now (the refusals above dialed it), so the device hub must
    // stay COMPLETELY flat for the whole transfer: no frame of it may
    // ride the stub.
    const hubBaseline = stub.forwardedCount();
    const chunksBefore = peerA.invokeCount("sync:bundleChunk");
    const refsBefore = await refSnapshot(targetRepo);
    // The chunk requests are windowed, not one per round trip, and the
    // final chunk (which makes the host drop the transfer) is asked
    // for only once every other one has landed.
    const windowed = observedChunks(sync, "bundleChunk");
    const { fetched } = await fetchBundleFromPeer(windowed.peer, {
      sourceProjectId,
      targetProjectId,
      refs: ["refs/heads/feature", dirtyRef],
      haves: [baseSha],
    });
    const chunkReqs = peerA.invokeCount("sync:bundleChunk") - chunksBefore;
    assert.ok(
      chunkReqs >= 4,
      `expected >= 4 chunks for the bundle, saw ${chunkReqs}`,
    );
    assert.ok(
      windowed.seen.most >= 2,
      `expected the chunk requests to overlap, saw ${windowed.seen.most} in flight`,
    );
    assert.equal(
      windowed.seen.othersAtEof,
      0,
      "the final chunk was requested while others were still in flight",
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
    assert.equal(sourceBlob.length, 2_700_000);
    assert.ok(
      Buffer.compare(sourceBlob, targetBlob) === 0,
      "transferred blob differs byte-for-byte",
    );
    ok(
      "granted transfer: >2.5 MB bundle crosses in >= 4 overlapping chunks and lands only under refs/shigomori/ with byte-identical objects",
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

    // (6) The push direction: this device bundles a branch and writes
    // it to the peer in chunks. Against a host that takes them
    // pipelined the chunks overlap (in offset order still), against an
    // older host that never said so they go one at a time, and either
    // way the ref lands under refs/shigomori/ with the exact tip.
    await git(targetRepo, ["checkout", "-q", "-b", "pushed"]);
    await commitFile(
      targetRepo,
      "pushed.bin",
      randomBytes(2_700_000),
      "pushed from the target",
    );
    const pushedTip = await gitOut(targetRepo, "rev-parse", "HEAD");
    await git(targetRepo, ["checkout", "-q", "main"]);
    const pushInput = {
      localProject: await findProjectOrThrow(targetProjectId),
      peerProjectId: sourceProjectId,
      refs: ["refs/heads/pushed"],
      haves: [baseSha],
    };
    const pipelined = observedChunks(sync, "pushChunk");
    const pushed = await pushBundleToPeer(pipelined.peer, pushInput);
    assert.deepEqual(pushed.fetched, [
      { ref: "refs/shigomori/incoming/pushed", commit: pushedTip },
    ]);
    assert.equal(
      await gitOut(
        sourceRepo,
        "rev-parse",
        "--verify",
        "refs/shigomori/incoming/pushed",
      ),
      pushedTip,
    );
    assert.ok(
      pipelined.seen.offsets.length >= 4,
      `expected >= 4 push chunks, saw ${pipelined.seen.offsets.length}`,
    );
    assert.ok(
      pipelined.seen.most >= 2,
      `expected the push chunks to overlap, saw ${pipelined.seen.most} in flight`,
    );
    assert.deepEqual(
      pipelined.seen.offsets,
      pipelined.seen.offsets.toSorted((x, y) => x - y),
      "push chunks were sent out of offset order",
    );
    const olderHost = observedChunks(
      {
        ...sync,
        pushStart: async (input) => {
          const { transferId } = await sync.pushStart(input);
          return { transferId };
        },
      },
      "pushChunk",
    );
    await pushBundleToPeer(olderHost.peer, pushInput);
    assert.equal(
      olderHost.seen.most,
      1,
      "chunks overlapped against a host that never said it takes them pipelined",
    );
    const strayPush = await sync.pushStart({
      projectId: sourceProjectId,
      bytes: 10,
    });
    await assert.rejects(
      () =>
        sync.pushChunk({
          transferId: strayPush.transferId,
          offset: 5,
          dataB64: Buffer.from("hello").toString("base64"),
        }),
      /push chunk out of order/,
    );
    ok(
      "push: a >2.5 MB bundle crosses in overlapping in-order chunks and lands under refs/shigomori/, an older host gets them one at a time, and an out-of-order chunk is refused",
    );

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
      // The clone's reach: the peer's default branch, over the same wire.
      projectsApiFor: (deviceId) => {
        assert.equal(deviceId, "A", "the clone dialed an unexpected device");
        return projectsOverWire;
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
    await commitFile(wt3Path, "third.txt", "third feature\n", "third feature");
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
    const wt4Path = await addWorktree(
      sourceRepo,
      "wt4",
      "feature4",
      "committed.txt",
      "committed\n",
      "fourth feature",
    );
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
    const wt5Path = await addWorktree(sourceRepo, "wt5", "feature5");
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
    const wt6Path = await addWorktree(
      sourceRepo,
      "wt6",
      "feature6",
      "sixth.txt",
      "sixth\n",
      "sixth feature",
    );
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

    // ---- The send, the pull turned around: the handler runs HERE as
    // the device holding the source, and the peer it lands on is the
    // same wire (its identity scan takes the target repo, registered
    // first). The push, the peer's landing and the local teardown are
    // production code against real git.
    const wt7Path = await addWorktree(
      sourceRepo,
      "wt7",
      "feature7",
      "seventh.txt",
      "seventh\n",
      "seventh feature",
    );
    writeFileSync(join(wt7Path, "draft.txt"), "sent draft\n");
    const wt7 = {
      targetDeviceId: "A",
      projectId: sourceProjectId,
      worktreeId: worktreeIdFromPath(wt7Path),
    };
    await assert.rejects(
      () => syncHandlers.teardownSent(wt7, pullCtx),
      /No send recorded/,
    );
    const sent = await syncHandlers.sendWorktree(wt7, pullCtx);
    assert.equal(sent.captured, true);
    assert.equal(sent.dirtyApplied, true);
    assert.equal(sent.worktree.projectId, targetProjectId);
    assert.equal(sent.worktree.branch, "feature7");
    assert.equal(
      readFileSync(join(sent.worktree.path, "seventh.txt"), "utf8"),
      "seventh\n",
      "the branch's commit landed on the peer",
    );
    assert.equal(
      readFileSync(join(sent.worktree.path, "draft.txt"), "utf8"),
      "sent draft\n",
      "the uncommitted work was re-applied on the peer",
    );
    await assert.rejects(
      () =>
        git(targetRepo, [
          "rev-parse",
          "--verify",
          "-q",
          "refs/shigomori/incoming/feature7",
        ]),
      undefined,
      "the peer's incoming ref must be swept",
    );
    // A second send meets the branch the first one landed, refused by
    // the peer before a byte moves and attributed to it.
    await assert.rejects(
      () => syncHandlers.sendWorktree(wt7, pullCtx),
      /The other device answered: feature7 is already checked out/,
    );
    writeFileSync(join(wt7Path, "draft.txt"), "sent draft, then edited\n");
    const keptSent = await syncHandlers.teardownSent(wt7, pullCtx);
    assert.equal(keptSent.sourceRemoved, false);
    assert.match(keptSent.sourceError ?? "", /changed after/);
    assert.equal(existsSync(wt7Path), true, "a changed source must survive");
    writeFileSync(join(wt7Path, "draft.txt"), "sent draft\n");
    const tornSent = await syncHandlers.teardownSent(wt7, pullCtx);
    assert.equal(tornSent.sourceRemoved, true, tornSent.sourceError);
    assert.equal(existsSync(wt7Path), false);
    ok(
      "sendWorktree: a dirty worktree lands on the peer with its commit and its uncommitted work, a repeat is refused by the peer, and teardownSent removes the local source only while it still matches what was sent",
    );

    // ---- A primary checkout, landing on its mirror branch
    // (landBranch): the copy is an ordinary worktree on mirror/main
    // carrying main's commits and uncommitted work, and the target's
    // own primary (on main) is untouched. The source's primary is on
    // main, one commit ahead of the target's after this.
    await commitFile(sourceRepo, "ff.txt", "from main\n", "main moves on");
    const mainTip = await gitOut(sourceRepo, "rev-parse", "HEAD");
    writeFileSync(join(sourceRepo, "primary-draft.txt"), "primary draft\n");
    const targetMainBefore = await gitOut(targetRepo, "rev-parse", "HEAD");
    // The landing branch is the mirror start's to decide (off the
    // peer's list), not the wire's: the orchestration takes it as an
    // option. A branch named mirror stands in mirror/main's way at
    // git's ref boundary, refused before anything crosses.
    const primaryPull = {
      sourceDeviceId: "A",
      sourceProjectId,
      sourceWorktreeId: worktreeIdFromPath(sourceRepo),
      sourceIdentity: identity,
      branch: "main",
      worktreeName: "pulled-primary",
    };
    await git(targetRepo, ["branch", "mirror", baseSha]);
    await assert.rejects(
      () =>
        runPullWorktree(primaryPull, pullCtx, { landBranch: "mirror/main" }),
      /a branch named mirror is in the way/,
    );
    await git(targetRepo, ["branch", "-D", "mirror"]);
    const primaryPulled = await runPullWorktree(primaryPull, pullCtx, {
      landBranch: "mirror/main",
    });
    assert.equal(primaryPulled.worktree.isPrimary, false);
    assert.equal(primaryPulled.worktree.branch, "mirror/main");
    assert.equal(primaryPulled.dirtyApplied, true);
    assert.equal(
      await gitOut(primaryPulled.worktree.path, "rev-parse", "HEAD"),
      mainTip,
    );
    assert.equal(
      readFileSync(
        join(primaryPulled.worktree.path, "primary-draft.txt"),
        "utf8",
      ),
      "primary draft\n",
    );
    assert.equal(
      await gitOut(targetRepo, "rev-parse", "HEAD"),
      targetMainBefore,
      "the target's own primary must not move",
    );
    assert.equal(
      await gitOut(targetRepo, "rev-parse", "--abbrev-ref", "HEAD"),
      "main",
    );
    assert.equal(
      await refExists(targetRepo, "refs/shigomori/incoming/main"),
      false,
    );
    ok(
      "pullWorktree of a primary: refuses a branch named mirror in the way, then lands as a worktree on mirror/main with main's tip and uncommitted work, leaving the target's primary alone",
    );

    // The same from the other side: the send reads the mirror branch
    // off the source being a primary. On a fresh branch here, so the
    // copy above does not hold the name.
    rmSync(join(sourceRepo, "primary-draft.txt"));
    await git(sourceRepo, ["checkout", "-q", "-b", "primary-branch"]);
    writeFileSync(join(sourceRepo, "sent-draft.txt"), "sent from primary\n");
    const primarySend = {
      targetDeviceId: "A",
      projectId: sourceProjectId,
      worktreeId: worktreeIdFromPath(sourceRepo),
    };
    // A plain send refuses the primary (it is the project itself). The
    // mirror start's send takes it.
    await assert.rejects(
      () => syncHandlers.sendWorktree(primarySend, pullCtx),
      /primary checkout can be mirrored but not sent/,
    );
    const { result: primarySent } = await sendWorktree(primarySend, pullCtx, {
      mirror: true,
    });
    assert.equal(primarySent.worktree.isPrimary, false);
    assert.equal(primarySent.worktree.branch, "mirror/primary-branch");
    assert.equal(primarySent.dirtyApplied, true);
    assert.equal(
      await gitOut(primarySent.worktree.path, "rev-parse", "HEAD"),
      mainTip,
    );
    assert.equal(
      readFileSync(join(primarySent.worktree.path, "sent-draft.txt"), "utf8"),
      "sent from primary\n",
    );
    assert.equal(
      await gitOut(targetRepo, "rev-parse", "--abbrev-ref", "HEAD"),
      "main",
      "the peer's primary stays on its branch",
    );
    ok(
      "sendWorktree from a primary: lands on the peer as a worktree on mirror/<branch> with the uncommitted work, its primary untouched",
    );

    // ---- A device with no checkout of the repo: the clone from a peer
    // (host/lib/sync/cloneFromPeer.ts) makes one over the same wire,
    // the pull's landing project when it is told where (cloneInto).
    // Both devices share one registry here, so a pull's identity scan
    // always finds a checkout (the source itself) and never reaches
    // the clone: the clone is driven directly, and what the pull
    // proves is that a checkout it has wins over a place named for a
    // new one. The clone end to end is the remote smoke's.
    // The source has a remote, which the clone must carry: it is what a
    // clone of that remote would be, and a repo whose default branch is
    // only its remote's HEAD to go by reads as the same repo through it.
    const originUrl = "https://github.com/example/lone.git";
    await git(sourceRepo, ["remote", "add", "origin", originUrl]);
    // A parent this machine does not have yet is made (the dialog's
    // default is the peer's own layout).
    const clonesDir = join(sandbox, "clones", "deep");
    const peer = { sync, projects: projectsOverWire };
    const cloneFrames = [];
    const cloned = await cloneProjectFromPeer(
      peer,
      sourceProjectId,
      { parentDir: clonesDir, name: "lone" },
      "feat/landing",
      (bytes, totalBytes) => cloneFrames.push([bytes, totalBytes]),
    );
    assert.equal(cloned.path, join(clonesDir, "lone"));
    assert.equal(
      await gitOut(cloned.path, "remote", "get-url", "origin"),
      originUrl,
    );
    assert.equal(
      await gitOut(cloned.path, "symbolic-ref", "refs/remotes/origin/HEAD"),
      "refs/remotes/origin/main",
    );
    assert.equal(
      await gitOut(cloned.path, "rev-parse", "--abbrev-ref", "main@{upstream}"),
      "origin/main",
    );
    assert.equal((await findProjectOrThrow(cloned.id)).path, cloned.path);
    // The source's default branch (main, not the primary-branch its
    // primary sits on), checked out at the source's tip, the tree
    // populated, and the incoming ref swept.
    assert.equal(
      await gitOut(cloned.path, "symbolic-ref", "HEAD"),
      "refs/heads/main",
    );
    assert.equal(await gitOut(cloned.path, "rev-parse", "HEAD"), mainTip);
    assert.equal(
      readFileSync(join(cloned.path, "ff.txt"), "utf8"),
      "from main\n",
    );
    assert.equal(await gitOut(cloned.path, "status", "--porcelain"), "");
    assert.equal(
      await gitOut(cloned.path, "for-each-ref", "refs/shigomori/"),
      "",
    );
    assert.equal(
      await getRepoIdentity(cloned.path),
      identity,
      "the clone must read as the same repo",
    );
    assert.ok(cloneFrames.length >= 2, "the clone reported no progress");
    assert.deepEqual(cloneFrames[0], [0, cloneFrames[0][1]]);
    assert.deepEqual(cloneFrames.at(-1), [
      cloneFrames[0][1],
      cloneFrames[0][1],
    ]);
    // A taken folder, a parent that is a file, and a landing branch the
    // clone itself checks out are refused before anything is made, and
    // none leaves a folder or a registration behind.
    const before = (await listProjects()).length;
    await assert.rejects(
      () =>
        cloneProjectFromPeer(
          peer,
          sourceProjectId,
          { parentDir: clonesDir, name: "lone" },
          "feat/landing",
        ),
      /already exists/,
    );
    writeFileSync(join(sandbox, "notafolder"), "");
    await assert.rejects(
      () =>
        cloneProjectFromPeer(
          peer,
          sourceProjectId,
          { parentDir: join(sandbox, "notafolder"), name: "x" },
          "feat/landing",
        ),
      /is not a folder/,
    );
    await assert.rejects(
      () =>
        cloneProjectFromPeer(
          peer,
          sourceProjectId,
          { parentDir: clonesDir, name: "y" },
          "main",
        ),
      /would land on main/,
    );
    assert.equal(existsSync(join(clonesDir, "y")), false);
    assert.equal((await listProjects()).length, before);
    // A pull told where to clone beside a checkout it already has
    // takes the checkout: nothing is cloned and the result says so.
    const wtBesidePath = await addWorktree(sourceRepo, "wt-beside", "beside");
    const beside = await syncHandlers.pullWorktree(
      {
        sourceDeviceId: "A",
        sourceProjectId,
        sourceWorktreeId: worktreeIdFromPath(wtBesidePath),
        sourceIdentity: identity,
        branch: "beside",
        worktreeName: "beside",
        cloneInto: { parentDir: clonesDir, name: "again" },
      },
      pullCtx,
    );
    assert.equal(beside.cloned, undefined);
    assert.equal(beside.worktree.projectId, targetProjectId);
    assert.equal(existsSync(join(clonesDir, "again")), false);
    ok(
      "cloneProjectFromPeer: the peer's default branch lands as a registered checkout of the same identity with its remote and progress reported, a taken folder, a parent that is a file and a landing on the default branch are refused clean, and a pull with cloneInto beside a checkout it has clones nothing",
    );
  } finally {
    // Reverse creation order via the shared tracker: the direct
    // sessions and listener first, then the hub connections, then
    // the stub.
    await teardown();
  }

  done();
}

main().catch(fail).finally(fixture.remove);
