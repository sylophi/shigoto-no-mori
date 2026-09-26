// Durable proof for moving worktrees between devices (direct-only):
// commits cross as git bundles on SOURCE LINKS, raw bytes on a byte
// channel of a REAL DIRECT websocket between the two fixtures,
// brokered by the stub device hub exactly as production does
// (test/lib/directBoot.mjs). Nothing here is a double on the sync path
// itself: device A registers the REAL sync contract and handlers on a
// real direct listener, the handlers shell the REAL sm binary (built
// from cli/ by this check), sm runs REAL git against fixture repos,
// and the receiver drives the REAL link helpers (host/lib/sync/
// sourceLink.ts) through the real dialer and bridge cache. Asserts:
//   - an ungranted peer is refused (typed CommandRefusedError) every
//     way a link opens, and the channel the attempt attached is gone;
//   - a capture over the link snapshots a dirty worktree to its
//     refs/shigomori/dirty/<id> ref with its tree, and
//     sync:ignoredPaths names the ignored file that capture leaves out;
//   - a >2.5 MB bundle (branch + dirty capture, thinned by a have)
//     crosses as many channel frames and lands ONLY under
//     refs/shigomori/ on the receiver with the source's exact tips,
//     byte-identical content via git cat-file, and no branch
//     materialized -- while the stub device hub's forwardedCount stays
//     FLAT (nothing but the one-time broker frames ever rides it);
//   - a channel id is single use, a finished link is gone at both
//     ends, a requester that gives up mid-bundle leaves no temp file on
//     the source, and an ask outside the ref allowlist resets the link;
//   - unpacking a corrupted bundle fails with the coded "bad-bundle";
//   - the push direction (the git follower's) lands a >2.5 MB bundle
//     under refs/shigomori/ on the peer.
//
// The moves run end to end below, against the same wire and the same
// real CLI: the pull, the transplant on top of it (pull plus source
// teardown over the peer's grant-gated worktrees:delete), the send
// (the same landing, run by the peer over a link this device opened),
// and both of them into a device with no checkout of the repo, which
// clones it first.
//
// Both "devices" share one node process and one sandboxed
// SHIGOMORI_DATA_DIR holding two projects (source and target repos); what
// separates them is the direct wire between them, which is exactly the
// surface this proof pins. The one exception is the send into an
// empty device: there the sending side's CLI runs against a registry
// of its own (see sendsAsOtherDevice). Runs under
// test/lib/register-ts-alias.mjs. Run: pnpm test sync-transfer.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CommandRefusedError } from "@shared/ipc/socket/frames";
import { buildClient } from "@shared/ipc/buildClient";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { setPeerSyncApiImpl } from "@host/ipc/peerSync";
import { sendWorktree, syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import {
  getRunningScriptWorktrees,
  killScriptsForWorktree,
  startScript,
} from "@host/lib/scripts";
import { cloneProjectFromPeer } from "@host/lib/sync/cloneFromPeer";
import {
  attachLink,
  LINK_GONE,
  offerSource,
  withPeerSource,
} from "@host/lib/sync/sourceLink";
import { mintHexId } from "@host/lib/hexId";
import { findProjectOrThrow, listProjects } from "@host/lib/projects";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import {
  cliFailureMessage,
  createCliRunner,
  makeProof,
  makeTracker,
  waitFor,
} from "./lib/checkKit.mjs";
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

// A session's byte channels with every one attached through them
// observed: the ids, and the data frames and bytes each way, so a
// check can pin that a bundle crossed as channel frames and that a
// link is gone once done.
function observedChannels(channelsOf) {
  const seen = { ids: [], framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0 };
  let mux = null;
  return {
    seen,
    has: (channelId) => mux?.has(channelId) ?? false,
    channels: async () => {
      mux = await channelsOf();
      return {
        has: (channelId) => mux.has(channelId),
        attach: (channelId, endpoint) => {
          seen.ids.push(channelId);
          const handle = mux.attach(channelId, {
            ...endpoint,
            onData: (data, consumed) => {
              seen.framesIn += 1;
              seen.bytesIn += data.length;
              endpoint.onData(data, consumed);
            },
          });
          return {
            channelId,
            get open() {
              return handle.open;
            },
            write: (data) => {
              seen.framesOut += 1;
              seen.bytesOut += data.length;
              return handle.write(data);
            },
            end: () => handle.end(),
            reset: () => handle.reset(),
          };
        },
      };
    },
  };
}

// The grant's refusal, typed, as a peer that does not accept commands
// answers every gated call.
const refusedTyped = (error) =>
  error instanceof CommandRefusedError &&
  /not permitted to run commands/.test(error.message);

// The sm-sync-* temp dirs under a tmp dir: a bundle's own, on either
// end of a link.
const syncTempDirs = (dir) =>
  readdirSync(dir).filter((name) => name.startsWith("sm-sync-"));

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
    ],
  });
  try {
    const sync = buildClient(syncContract, peerA.transport);
    const worktreesOverWire = buildClient(worktreesContract, peerA.transport);
    const dirtyRef = `refs/shigomori/dirty/${worktreeId}`;

    // The peer as the orchestrations reach it: the sync surface plus
    // the session's byte channels, observed.
    const observed = observedChannels(peerA.channels);
    const peerSync = { ...sync, channels: observed.channels };
    const worktreeRef = { projectId: sourceProjectId, worktreeId };
    const targetProject = await findProjectOrThrow(targetProjectId);

    // (1) Ungranted: every way a link opens is refused typed, before
    // any handler runs, and the channel each attempt attached is gone
    // again: a pull's link (the source's grant), a send's landing and
    // a push (the destination's).
    await assert.rejects(
      () =>
        withPeerSource(peerSync, worktreeRef, (source) =>
          source.tip("feature"),
        ),
      refusedTyped,
    );
    await assert.rejects(
      () =>
        offerSource(peerSync, targetProject, worktreeId, (channelId) =>
          sync.receiveBundle({
            projectId: sourceProjectId,
            refs: ["refs/heads/main"],
            haves: [],
            channelId,
          }),
        ),
      refusedTyped,
    );
    await assert.rejects(
      () =>
        offerSource(peerSync, targetProject, worktreeId, (channelId) =>
          sync.receiveWorktree({
            identity: "root:0000000000000000000000000000000000000000",
            branch: "feature",
            sourceWorktreeId: worktreeId,
            channelId,
          }),
        ),
      refusedTyped,
    );
    assert.equal(observed.seen.ids.length, 3);
    for (const channelId of observed.seen.ids) {
      assert.equal(observed.has(channelId), false, "a refused link stayed");
    }
    // The transplant teardown rides the same gate: worktrees:delete over
    // the wire is refused typed for an ungranted peer too.
    await assert.rejects(
      () =>
        worktreesOverWire.delete({ projectId: sourceProjectId, worktreeId }),
      (error) => error instanceof CommandRefusedError,
    );
    ok(
      "ungranted peer: openSource, receiveBundle, receiveWorktree and worktrees:delete are refused with the typed CommandRefusedError, and no refused link stays attached",
    );

    listener.setAccepts(true);

    // (2) A capture over the link: a dirty worktree snapshots to its
    // capture ref on the host, its commit and tree answered. An ignored
    // file sits beside the dirt: the capture has `git add -A`
    // semantics, so it must stay out of the capture and be named by
    // ignoredPaths, which is how the transplant dialog says what a
    // teardown takes.
    writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted work\n");
    writeFileSync(join(worktreePath, ".gitignore"), "secret.env\n");
    writeFileSync(join(worktreePath, "secret.env"), "FIXTURE_ONLY=1\n");
    const capture = await withPeerSource(peerSync, worktreeRef, (source) =>
      source.capture(),
    );
    assert.equal(capture.captured, true, "capture reported clean");
    const captureTip = await gitOut(sourceRepo, "rev-parse", dirtyRef);
    assert.equal(capture.commit, captureTip);
    assert.equal(
      capture.tree,
      await gitOut(sourceRepo, "rev-parse", `${captureTip}^{tree}`),
    );
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
      "a capture over the link snapshots the worktree to its capture ref with its tree, and ignoredPaths names the file it leaves out",
    );

    // (3) The full transfer: branch + capture ref, thinned by the
    // receiver's base tip, as many channel frames, exact tips, allowed
    // namespaces only, byte-identical objects. The direct session is
    // established by now (the refusals above dialed it), so the device
    // hub must stay COMPLETELY flat for the whole transfer: no frame of
    // it may ride the stub.
    const hubBaseline = stub.forwardedCount();
    const framesBefore = observed.seen.framesIn;
    const bytesBefore = observed.seen.bytesIn;
    const refsBefore = await refSnapshot(targetRepo);
    const progressed = [];
    const { fetched } = await withPeerSource(peerSync, worktreeRef, (source) =>
      source.fetch({
        refs: ["refs/heads/feature", dirtyRef],
        haves: [baseSha],
        into: targetProject,
        onProgress: (bytes, total) => progressed.push([bytes, total]),
      }),
    );
    const bundleBytes = progressed[0]?.[1] ?? 0;
    assert.ok(
      bundleBytes > 1_500_000,
      `thin bundle unexpectedly small: ${bundleBytes} bytes`,
    );
    assert.deepEqual(progressed[0], [0, bundleBytes]);
    assert.deepEqual(progressed.at(-1), [bundleBytes, bundleBytes]);
    assert.ok(
      observed.seen.bytesIn - bytesBefore >= bundleBytes,
      "the bundle did not cross as channel bytes",
    );
    const frames = observed.seen.framesIn - framesBefore;
    assert.ok(
      frames >= 4,
      `expected the bundle in >= 4 channel frames, saw ${frames}`,
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
      "granted transfer: a >2.5 MB bundle crosses as channel frames with its progress, and lands only under refs/shigomori/ with byte-identical objects",
    );

    // (4) Link lifecycle. Every link so far is gone at both ends. A
    // channel id is single use: a second open under a live one is
    // refused. A requester that gives up mid-bundle (a bundle past the
    // channel's window, so the source is still sending) leaves no temp
    // file on the source. An ask outside the ref allowlist resets the
    // link, the same wall the invoke schemas were.
    await waitFor(
      () => observed.seen.ids.every((channelId) => !observed.has(channelId)),
      "every finished link to be gone here",
    );
    const mux = await peerA.channels();
    const manualLink = async (channelId = mintHexId()) => {
      const link = attachLink((endpoint) => mux.attach(channelId, endpoint));
      await sync.openSource({ ...worktreeRef, channelId });
      return { channelId, link };
    };
    const first = await manualLink();
    await assert.rejects(
      () => sync.openSource({ ...worktreeRef, channelId: first.channelId }),
      /channel-taken/,
    );
    first.link.end();
    await waitFor(
      () => !mux.has(first.channelId),
      "an ended link to complete at both ends",
    );

    await git(sourceRepo, ["checkout", "-q", "-b", "huge"]);
    await commitFile(sourceRepo, "huge.bin", randomBytes(6_000_000), "huge");
    await git(sourceRepo, ["checkout", "-q", "main"]);
    const tmp = join(sandbox, "tmp");
    mkdirSync(tmp);
    const tmpBefore = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const giving = await manualLink();
      await giving.link.write({
        ask: "bundle",
        refs: ["refs/heads/huge"],
        haves: [baseSha],
      });
      const header = await giving.link.read();
      assert.ok(header.bundle.bytes > 5_000_000, "the huge bundle is small");
      await waitFor(
        () => syncTempDirs(tmp).length === 1,
        "the source to hold its bundle while it sends",
      );
      // Reading none of it, the source stalls on credit, then this side
      // gives up.
      giving.link.reset();
      await waitFor(
        () => syncTempDirs(tmp).length === 0,
        "the source to drop its bundle once the requester gave up",
      );
      assert.equal(mux.has(giving.channelId), false);
    } finally {
      if (tmpBefore === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpBefore;
    }

    const bad = await manualLink();
    await bad.link.write({ ask: "bundle", refs: ["refs/tags/v1"], haves: [] });
    await assert.rejects(() => bad.link.read(), new RegExp(LINK_GONE));
    ok(
      "lifecycle: finished links are gone at both ends, a channel id is single use, a requester giving up mid-bundle leaves the source no temp file, and an ask outside the allowlist resets the link",
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

    // (6) The push direction (the git follower's): this device opens a
    // link on the peer, which asks it for the bundle, and the ref lands
    // under refs/shigomori/ there with the exact tip.
    await git(targetRepo, ["checkout", "-q", "-b", "pushed"]);
    await commitFile(
      targetRepo,
      "pushed.bin",
      randomBytes(2_700_000),
      "pushed from the target",
    );
    const pushedTip = await gitOut(targetRepo, "rev-parse", "HEAD");
    await git(targetRepo, ["checkout", "-q", "main"]);
    const outBefore = observed.seen.bytesOut;
    const pushed = await offerSource(
      peerSync,
      targetProject,
      worktreeIdFromPath(targetRepo),
      (channelId) =>
        sync.receiveBundle({
          projectId: sourceProjectId,
          refs: ["refs/heads/pushed"],
          haves: [baseSha],
          channelId,
        }),
    );
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
      observed.seen.bytesOut - outBefore > 1_500_000,
      "the pushed bundle did not cross as channel bytes",
    );
    ok(
      "push: a >2.5 MB bundle crosses on a link the pusher opened and lands under refs/shigomori/ on the peer",
    );

    // ---- The pull orchestration, end to end. The handler runs HERE
    // as device B (the registered surface above is A's), with its two
    // real seams injected: the CLI runner (already set) and the peer
    // sync api, which is the SAME direct-wire client and channels the
    // transfer tests drove. Everything in between -- the tip, the
    // capture, the bundle, `sm create`, the capture re-key, `sm dirty
    // apply` -- is production code against real git.
    setPeerSyncApiImpl({
      syncApiFor: (deviceId) => {
        assert.equal(deviceId, "A", "the move dialed an unexpected device");
        return peerSync;
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
          direction: "pull",
          deviceId: input.sourceDeviceId,
          projectId: input.sourceProjectId,
          worktreeId: input.sourceWorktreeId,
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
          direction: "pull",
          deviceId: "A",
          projectId: sourceProjectId,
          worktreeId: "0123456789ab",
        },
        pullCtx,
      ),
      /No pull recorded/,
    );
    await assert.rejects(
      syncHandlers.teardownSource(
        {
          direction: "pull",
          deviceId: "A",
          projectId: sourceProjectId,
          worktreeId: wt3Id,
        },
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
      direction: "pull",
      deviceId: "A",
      projectId: sourceProjectId,
      worktreeId: wt6Id,
    };
    const latePull = await syncHandlers.pullWorktree(
      {
        sourceDeviceId: "A",
        sourceProjectId,
        sourceWorktreeId: wt6Id,
        sourceIdentity: identity,
        branch: "feature6",
      },
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
    // the device holding the source, and the peer lands it (its
    // identity scan takes the target repo, registered first), asking
    // back over the link this side opened. The landing, the relayed
    // progress and the local teardown are production code against
    // real git.
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
    const wt7Sent = {
      direction: "send",
      deviceId: "A",
      projectId: sourceProjectId,
      worktreeId: wt7.worktreeId,
    };
    // The peer's frames, relayed here under the local worktree's id.
    const sendFrames = [];
    const sendCtx = {
      ...pullCtx,
      notifier: () => (frame) => sendFrames.push(frame),
    };
    await assert.rejects(
      () => syncHandlers.teardownSource(wt7Sent, pullCtx),
      /No send recorded/,
    );
    const sent = await syncHandlers.sendWorktree(wt7, sendCtx);
    assert.ok(
      sendFrames.every((frame) => frame.sourceWorktreeId === wt7.worktreeId),
    );
    const sentSteps = new Set(sendFrames.map((frame) => frame.step));
    for (const step of ["capture", "transfer", "create", "apply"]) {
      assert.ok(sentSteps.has(step), `the send never reported ${step}`);
    }
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
    const keptSent = await syncHandlers.teardownSource(wt7Sent, pullCtx);
    assert.equal(keptSent.sourceRemoved, false);
    assert.match(keptSent.sourceError ?? "", /changed after/);
    assert.equal(existsSync(wt7Path), true, "a changed source must survive");
    writeFileSync(join(wt7Path, "draft.txt"), "sent draft\n");
    const tornSent = await syncHandlers.teardownSource(wt7Sent, pullCtx);
    assert.equal(tornSent.sourceRemoved, true, tornSent.sourceError);
    assert.equal(existsSync(wt7Path), false);
    ok(
      "sendWorktree: a dirty worktree lands on the peer with its commit and its uncommitted work and the peer's progress relayed, a repeat is refused by the peer, and the teardown removes the local source only while it still matches what was sent",
    );

    // ---- A primary checkout, sent the way the mirror start sends it:
    // the copy is an ordinary worktree on mirror/<branch> carrying the
    // branch's commits and uncommitted work, and the target's own
    // primary (on main) is untouched. The source's primary moves one
    // commit ahead of the target's, then onto a fresh branch.
    await commitFile(sourceRepo, "ff.txt", "from main\n", "main moves on");
    const mainTip = await gitOut(sourceRepo, "rev-parse", "HEAD");
    const targetMainBefore = await gitOut(targetRepo, "rev-parse", "HEAD");
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
    // The landing branch is read off the source being a primary, never
    // taken from the wire. A branch named mirror stands in its way at
    // git's ref boundary, refused on the peer before anything crosses.
    await git(targetRepo, ["branch", "mirror", baseSha]);
    await assert.rejects(
      () => sendWorktree(primarySend, pullCtx, { mirror: true }),
      /a branch named mirror is in the way/,
    );
    await git(targetRepo, ["branch", "-D", "mirror"]);
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
    assert.equal(
      await gitOut(targetRepo, "rev-parse", "HEAD"),
      targetMainBefore,
      "the peer's own primary must not move",
    );
    assert.equal(
      await refExists(targetRepo, "refs/shigomori/incoming/primary-branch"),
      false,
    );
    ok(
      "sendWorktree from a primary: refuses a branch named mirror in the way, then lands on the peer as a worktree on mirror/<branch> with the tip and the uncommitted work, its primary untouched",
    );

    // ---- A device with no checkout of the repo: the clone from a peer
    // (host/lib/sync/cloneFromPeer.ts) makes one over the same wire,
    // the landing project when it is told where (cloneInto). Both
    // devices share one registry here, so a pull's identity scan always
    // finds a checkout (the source itself) and never reaches the clone:
    // the clone is driven directly, and what the pull proves is that a
    // checkout it has wins over a place named for a new one. The send
    // that follows takes the clone end to end, the sending side on a
    // registry of its own.
    // The source has a remote, which the clone must carry: it is what a
    // clone of that remote would be, and a repo whose default branch is
    // only its remote's HEAD to go by reads as the same repo through it.
    const originUrl = "https://github.com/example/lone.git";
    await git(sourceRepo, ["remote", "add", "origin", originUrl]);
    // A parent this machine does not have yet is made (the dialog's
    // default is the peer's own layout).
    const clonesDir = join(sandbox, "clones", "deep");
    // The clone asks the source over a link, as a landing does: here a
    // pull's, opened on the source's primary.
    const cloneFrom = (...args) =>
      withPeerSource(
        peerSync,
        {
          projectId: sourceProjectId,
          worktreeId: worktreeIdFromPath(sourceRepo),
        },
        (source) => cloneProjectFromPeer(source, ...args),
      );
    const cloneFrames = [];
    const cloned = await cloneFrom(
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
      () => cloneFrom({ parentDir: clonesDir, name: "lone" }, "feat/landing"),
      /already exists/,
    );
    writeFileSync(join(sandbox, "notafolder"), "");
    await assert.rejects(
      () =>
        cloneFrom(
          { parentDir: join(sandbox, "notafolder"), name: "x" },
          "feat/landing",
        ),
      /is not a folder/,
    );
    await assert.rejects(
      () => cloneFrom({ parentDir: clonesDir, name: "y" }, "main"),
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

    // ---- A send into a device with no checkout of the repo: the peer
    // clones it from here first, over the same link the branch then
    // crosses, and lands the copy in the clone. The two ends need
    // registries of their own for this, or the peer's identity scan
    // finds the sender's own checkout: the sending side's CLI runs
    // against a second data dir, chosen by an async context around the
    // send (the runner seam is process-wide), where the lone repo is
    // registered. The landing side (A, the shared registry) has never
    // seen it.
    const sendsAsOtherDevice = new AsyncLocalStorage();
    const otherDataDir = join(sandbox, "data-other");
    mkdirSync(otherDataDir);
    const otherCli = createCliRunner(fixture.smBinary, {
      ...fixture.smEnv,
      SHIGOMORI_DATA_DIR: otherDataDir,
    });
    const asOtherDevice = (run) => sendsAsOtherDevice.run(true, run);
    setCliRunnerImpl({
      runCli: (args, onDoc) =>
        (sendsAsOtherDevice.getStore() === true ? otherCli : fixture).runCli(
          args,
          onDoc,
        ),
      requireCliBinary: () => fixture.smBinary,
      cliFailureMessage,
    });
    try {
      const loneRepo = join(sandbox, "lone-source");
      await git(sandbox, ["init", "-q", "-b", "main", "lone-source"]);
      await fixture.disableAutoGc(loneRepo);
      await commitFile(loneRepo, "root.txt", "root\n", "root");
      const loneMainTip = await gitOut(loneRepo, "rev-parse", "HEAD");
      const loneWtPath = await addWorktree(
        loneRepo,
        "lone-wt",
        "lone-feature",
        "lone.txt",
        "lone feature\n",
        "lone feature",
      );
      writeFileSync(join(loneWtPath, "lone-draft.txt"), "lone draft\n");
      const loneProjectId = (
        await otherCli.sm("projects", "add", "--", loneRepo)
      ).docs.findLast((doc) => typeof doc.id === "string").id;
      const loneWt = {
        targetDeviceId: "A",
        projectId: loneProjectId,
        worktreeId: worktreeIdFromPath(loneWtPath),
      };
      const sentInto = join(sandbox, "clones", "sent");
      const loneFrames = [];
      const loneSent = await asOtherDevice(() =>
        syncHandlers.sendWorktree(
          { ...loneWt, cloneInto: { parentDir: sentInto, name: "lone" } },
          { ...pullCtx, notifier: () => (frame) => loneFrames.push(frame) },
        ),
      );
      assert.ok(loneSent.cloned, "the send made no clone on the peer");
      assert.equal(loneSent.cloned.path, join(sentInto, "lone"));
      assert.equal(
        (await findProjectOrThrow(loneSent.cloned.id)).path,
        loneSent.cloned.path,
        "the clone is registered on the landing side",
      );
      assert.equal(
        await getRepoIdentity(loneSent.cloned.path),
        await getRepoIdentity(loneRepo),
        "the clone must read as the same repo",
      );
      assert.equal(
        await gitOut(loneSent.cloned.path, "symbolic-ref", "HEAD"),
        "refs/heads/main",
      );
      assert.equal(
        await gitOut(loneSent.cloned.path, "rev-parse", "HEAD"),
        loneMainTip,
      );
      assert.equal(loneSent.worktree.projectId, loneSent.cloned.id);
      assert.equal(loneSent.worktree.branch, "lone-feature");
      assert.equal(loneSent.dirtyApplied, true);
      assert.equal(
        readFileSync(join(loneSent.worktree.path, "lone.txt"), "utf8"),
        "lone feature\n",
      );
      assert.equal(
        readFileSync(join(loneSent.worktree.path, "lone-draft.txt"), "utf8"),
        "lone draft\n",
      );
      const cloneSteps = loneFrames.filter((frame) => frame.step === "clone");
      assert.ok(
        cloneSteps.some((frame) => (frame.totalBytes ?? 0) > 0),
        "the clone's bytes were never reported",
      );
      const loneSteps = new Set(loneFrames.map((frame) => frame.step));
      for (const step of ["clone", "capture", "transfer", "create", "apply"]) {
        assert.ok(loneSteps.has(step), `the send never reported ${step}`);
      }
      // Its teardown runs on the sending side, against that side's own
      // registry, on the receipt the peer's landing made.
      const loneTorn = await asOtherDevice(() =>
        syncHandlers.teardownSource(
          {
            direction: "send",
            deviceId: "A",
            projectId: loneProjectId,
            worktreeId: loneWt.worktreeId,
          },
          pullCtx,
        ),
      );
      assert.equal(loneTorn.sourceRemoved, true, loneTorn.sourceError);
      assert.equal(existsSync(loneWtPath), false);
      ok(
        "sendWorktree into a device with no checkout: the peer clones the repo from here over the link (progress relayed), registers it, lands the copy in it with its uncommitted work, and the teardown removes the source here",
      );
    } finally {
      setCliRunnerImpl({
        runCli: fixture.runCli,
        requireCliBinary: () => fixture.smBinary,
        cliFailureMessage,
      });
    }
  } finally {
    // Reverse creation order via the shared tracker: the direct
    // sessions and listener first, then the hub connections, then
    // the stub.
    await teardown();
  }

  done();
}

main().catch(fail).finally(fixture.remove);
