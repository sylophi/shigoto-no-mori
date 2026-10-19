// Durable proof for moving worktrees between devices (direct-only):
// commits cross as git bundles on SOURCE LINKS, raw bytes on a byte
// channel of a REAL DIRECT websocket between the two fixtures,
// brokered by the stub device hub exactly as production does
// (test/lib/directBoot.mts). Nothing here is a double on the sync path
// itself: the listener registers the REAL sync contract and handlers on a
// real direct listener, the handlers run the REAL engine in-process,
// which runs REAL git against fixture repos,
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
//   - what serves or waits past a call ends with its owner: a send
//     cancelled mid-bundle and a late answer's undo count as under way
//     until they're done, and the host's moves closing ends a serving
//     with its temp dir and its channel;
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
// empty device: there the sending side's engine runs against a registry
// of its own (see asOtherDevice). Run: pnpm test sync-transfer.
import assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { CommandRefusedError } from "@shigomori/contracts/errors";
import { effectClient } from "@shared/ipc/effectClient";
import type { EffectClient } from "@shigomori/contracts/types";
import {
  type SyncCloneInto,
  syncContract,
  type SyncMoveRef,
  SyncPullProgressSchema,
} from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { forwardContract } from "@shigomori/contracts/modules/forward";
import type { HandlerContext } from "@shared/ipc/transport";
import { WorktreeSchema } from "@shigomori/contracts/schemas";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import {
  type PeerChannels,
  type PeerReach,
  peerSyncFor,
} from "@host/ipc/PeerReach";
import {
  standInDeviceId,
  standInMirror,
  standInPeers,
} from "./lib/hostStandIns.mts";
import { inertMirrorImpl, rawMirrorSession } from "./lib/mirrorFakes.mts";
import { syncHandlers } from "@host/ipc/modules/sync";
import { sendWorktree as sendWorktreeOn } from "@host/lib/sync/move";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { hostContext, runHost, type Services } from "./lib/hostRuntime.mts";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { EngineChanges } from "@host/lib/Engine";
import * as Ops from "@host/lib/engineOps";
import * as Scripts from "@host/lib/Scripts";
import * as Moves from "@host/lib/sync/Moves";
import { cloneCheckoutFromPeer } from "@host/lib/sync/cloneFromPeer";
import * as Git from "@shigomori/engine/Git";
import { followDescription as followDescriptionOn } from "@host/lib/sync/worktreeDescription";
import {
  attachLink,
  attachLinkFarEnd,
  BundleAnswerSchema,
  LINK_GONE,
  offer,
  peerSource,
  type WorktreeSource,
} from "@host/lib/sync/sourceLink";
import { mintHexId } from "@host/lib/hexId";
import * as Projects from "@host/lib/projects";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import {
  createCliRunner,
  handlerCtx,
  makeTracker,
  processAlive,
  sleepingClock,
  testClock,
  waitFor,
} from "./lib/checkKit.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import {
  bootDirectWire,
  DIALER,
  type DirectWire,
  LISTENER,
  linkOver,
} from "./lib/directBoot.mts";
import type { ShigomoriConfig } from "@shigomori/contracts/schemas";
import { addProject, secondEngine } from "./lib/smBinary.mts";

// The host's engine reads and moves as Promises, on the sandbox's
// engine (runHost).
const readShigomoriConfig = (projectId: string) =>
  runHost(Ops.readProjectConfig(projectId));
const readWorktreeData = (projectId: string, worktreeId: string) =>
  runHost(Ops.readWorktreeData(projectId, worktreeId));
const writeWorktreeData = (...args: Parameters<typeof Ops.writeWorktreeData>) =>
  runHost(Ops.writeWorktreeData(...args));
const writeWorktreeDescription = (
  ...args: Parameters<typeof Ops.writeWorktreeDescription>
) => runHost(Ops.writeWorktreeDescription(...args));
const writeProjectConfig = (
  ...args: Parameters<typeof Ops.writeProjectConfig>
) => runHost(Ops.writeProjectConfig(...args));
const findProjectOrThrow = (projectId: string) =>
  runHost(Projects.findProject(projectId));
const listProjects = () => runHost(Projects.freshProjects);
const followDescription = (...args: Parameters<typeof followDescriptionOn>) =>
  runHost(followDescriptionOn(...args));
const pullWorktree = (...args: Parameters<typeof syncHandlers.pullWorktree>) =>
  runHost(syncHandlers.pullWorktree(...args));
const sendWorktreeHere = (
  ...args: Parameters<typeof syncHandlers.sendWorktree>
) => runHost(syncHandlers.sendWorktree(...args));
const sendWorktree = (...args: Parameters<typeof sendWorktreeOn>) =>
  runHost(sendWorktreeOn(...args));
// The source link to the listener's worktree, for the length of `use`.
const withPeerSource = <T, E>(
  worktree: { projectId: string; worktreeId: string },
  use: (source: WorktreeSource) => Effect.Effect<T, E, Services>,
) =>
  runHost(Effect.scoped(Effect.flatMap(peerSource(LISTENER, worktree), use)));
// A link this device offers the listener, opened there by `openOnPeer`.
const offerSource = <T, E>(
  project: Parameters<typeof offer>[1],
  worktreeId: string,
  openOnPeer: (channelId: string) => Effect.Effect<T, E, PeerReach>,
) => runHost(offer(LISTENER, project, worktreeId, openOnPeer));
const repoIdentityOf = (path: string) => runHost(Ops.repoIdentity(path));
// The kinds of change counted now (Scripts.busy words them).
const changesUnderWay = async () =>
  (
    await runHost(Effect.map(EngineChanges, (changes) => changes.underWay()))
  ).map(({ kind }) => kind);

// Whether the host's moves read a move under way (Moves.underWay).
const movesUnderWay = () =>
  runHost(
    Effect.flatMap(Moves.Moves, (moves) =>
      Effect.map(moves.underWay, ({ moving }) => moving),
    ),
  );

// The sandbox, the scrubbed process.env with pinned idents, the git
// wrappers, and the engine on the sandbox's data dir
// (test/lib/cliSandbox.mts).
const decodePullProgresses = Schema.decodeUnknownSync(
  Schema.Array(SyncPullProgressSchema),
);

// Every span either device makes, the listener's included.
const spans: Tracer.NativeSpan[] = [];
const tracer = Tracer.make({
  span: (options) => {
    const span = new Tracer.NativeSpan(options);
    spans.push(span);
    return span;
  },
});

const fixture = cliSandbox("sm-sync-check-");
const { sandbox, git, gitBytes, gitOut, runCli, sm } = fixture;
const { commitFile, addWorktree } = fixture;

async function refExists(repo: string, ref: string) {
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
async function refSnapshot(repo: string) {
  const out = await gitOut(
    repo,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  );
  return new Set(out ? out.split("\n") : []);
}

// A session's byte channels with every one attached through them
// observed: the ids, and the data frames and bytes each way, so a
// check can pin that a bundle crossed as channel frames and that a
// link is gone once done.
function observedChannels(channelsOf: PeerChannels) {
  const ids: string[] = [];
  const seen = { ids, framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0 };
  let mux: Awaited<ReturnType<PeerChannels>> | null = null;
  return {
    seen,
    has: (channelId: string) => mux?.has(channelId) ?? false,
    channels: async (): ReturnType<PeerChannels> => {
      const current = await channelsOf();
      mux = current;
      return {
        has: (channelId) => current.has(channelId),
        attach: (channelId, endpoint) => {
          seen.ids.push(channelId);
          const handle = current.attach(channelId, {
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
const refusedTyped = (error: unknown) =>
  error instanceof CommandRefusedError &&
  /not permitted to run commands/.test(error.message);

// The sm-sync-* temp dirs under a tmp dir: a bundle's own, on either
// end of a link.
const syncTempDirs = (dir: string) =>
  readdirSync(dir).filter((name) => name.startsWith("sm-sync-"));

let sourceRepo: string;
let baseSha: string;
let targetRepo: string;
let featureTip: string;
let worktreePath: string;
let worktree2Path: string;
let feature2Tip: string;
let worktreeId: string;
let targetProjectId: string;
let sourceProjectId: string;
let stub: DirectWire["stub"];
let listener: DirectWire["listener"];
let toListener: DirectWire["toListener"];
let sync: EffectClient<typeof syncContract>;
let worktreesOverWire: EffectClient<typeof worktreesContract>;
let forwardOverWire: EffectClient<typeof forwardContract>;
// What the listener's forward:open does: a proof's own far end of a
// link, or a call run on services of the proof's.
let onPeerOpen: (
  channelId: string,
  ctx: HandlerContext,
) => Effect.Effect<void> = () => Effect.void;
let dirtyRef: string;
let observed: ReturnType<typeof observedChannels>;
let worktreeRef: { projectId: string; worktreeId: string };
let targetProject: Awaited<ReturnType<typeof findProjectOrThrow>>;
let captureTip: string;
let pullCtx: ReturnType<typeof handlerCtx>;
let identity: string;
let cleanPull: Awaited<ReturnType<typeof pullWorktree>>;
let wt3Id: string;
let mainTip: string;

const { track, teardown } = makeTracker();

// The transplant as the dialog drives it: the pull, then the
// teardown reading the pull's own receipt.
const transplant = async (
  input: Parameters<typeof syncHandlers.pullWorktree>[0],
) => {
  const pulled = await pullWorktree(input, pullCtx);
  const torn = await runHost(
    syncHandlers.teardownSource(
      {
        direction: "pull",
        deviceId: input.sourceDeviceId,
        projectId: input.sourceProjectId,
        worktreeId: input.sourceWorktreeId,
      },
      pullCtx,
    ),
  );
  return { ...pulled, ...torn };
};

beforeAll(async () => {
  // ---- Fixtures: build the CLI, seed repos, register projects ----
  await fixture.buildSm();

  // Source repo: base commit on main, a "feature" branch carrying
  // ~2.7 MB of incompressible bytes (so the thin bundle still crosses
  // in >= 4 chunks), a linked worktree for the dirty capture.
  sourceRepo = await fixture.initRepo("source");
  await git(sourceRepo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  await commitFile(sourceRepo, "readme.txt", "base\n", "base");
  baseSha = await gitOut(sourceRepo, "rev-parse", "HEAD");

  // Target repo: a clone holding only the base history -- the
  // receiving device's copy of the same project.
  targetRepo = await fixture.cloneRepo(sourceRepo, "target");

  await git(sourceRepo, ["checkout", "-q", "-b", "feature"]);
  await commitFile(
    sourceRepo,
    "big.bin",
    randomBytes(2_700_000),
    "big feature",
  );
  featureTip = await gitOut(sourceRepo, "rev-parse", "HEAD");
  await git(sourceRepo, ["checkout", "-q", "main"]);

  worktreePath = await addWorktree(sourceRepo, "wt", "scratch");
  // A second worktree whose branch carries a commit the target has
  // never seen, for the pull proof's branch-transfer path (scratch sits
  // at the shared base commit, exercising the tip-already-local path).
  worktree2Path = await addWorktree(
    sourceRepo,
    "wt2",
    "feature2",
    "second.txt",
    "second feature\n",
    "second feature",
  );
  feature2Tip = await gitOut(worktree2Path, "rev-parse", "HEAD");
  // The real app derivation (the engine's worktreeLayout.ts), imported straight from its home now that
  // tsAliasLoader handles the transitive JSON import. The capture ref
  // must land at refs/shigomori/dirty/<this id>, asserted below.
  worktreeId = worktreeIdFromPath(worktreePath);

  await fixture.useCli();
  const { projectIdOf } = fixture;
  // Target first: both fixture projects share one registry AND one repo
  // identity (target is a clone), and the pull handler's identity scan
  // takes the first registry match -- which must be the pull's local
  // target for the round-trip proof below.
  targetProjectId = await projectIdOf(targetRepo);
  sourceProjectId = await projectIdOf(sourceRepo);

  // ---- The direct wire: the listener serves the real sync surface,
  // the dialer receives through the real dialer and
  // bridge cache, with the stub device hub carrying ONLY the broker
  // exchange (bootDirectWire, the shared fixture). Teardowns collect
  // on the shared tracker for the afterAll below.
  ({ stub, listener, toListener } = await bootDirectWire(track, {
    provide: Layer.succeed(Tracer.Tracer, tracer),
    contracts: [
      [syncContract, syncHandlers],
      // The teardown half of the transplant proof: the REAL worktrees
      // surface on the listener's wire, beside the sync surface. The usage hook is
      // the Electron binding's concern, so a no-op satisfies the
      // registrar.
      [worktreesContract, worktreesHandlers],
      // A proof's own far end of a link (onPeerOpen).
      [
        forwardContract,
        {
          open: ({ channelId }: { channelId: string }, ctx: HandlerContext) =>
            onPeerOpen(channelId, ctx),
        },
      ],
    ],
  }));
  forwardOverWire = effectClient(
    forwardContract,
    linkOver(toListener.transport),
  );
  sync = effectClient(syncContract, linkOver(toListener.transport));
  worktreesOverWire = effectClient(
    worktreesContract,
    linkOver(toListener.transport),
  );
  dirtyRef = `refs/shigomori/dirty/${worktreeId}`;

  // The peer as the orchestrations reach it: the sync surface plus
  // the session's byte channels, observed.
  observed = observedChannels(toListener.channels);
  standInPeers({
    transportFor: () => toListener.transport,
    channelsFor: () => observed.channels,
  });
  standInDeviceId(DIALER);
  worktreeRef = { projectId: sourceProjectId, worktreeId };
  targetProject = await findProjectOrThrow(targetProjectId);
});

afterAll(async () => {
  try {
    // Reverse creation order via the shared tracker: the direct
    // sessions and listener first, then the hub connections, then
    // the stub.
    await teardown();
  } finally {
    await fixture.remove();
  }
});

it("ungranted peer: openSource, receiveBundle, receiveWorktree and worktrees:delete are refused with the typed CommandRefusedError, and no refused link stays attached", async () => {
  // (1) Ungranted: every way a link opens is refused typed, before
  // any handler runs, and the channel each attempt attached is gone
  // again: a pull's link (the source's grant), a send's landing and
  // a push (the destination's).
  await assert.rejects(
    () => withPeerSource(worktreeRef, (source) => source.tip("feature")),
    refusedTyped,
  );
  await assert.rejects(
    () =>
      offerSource(targetProject, worktreeId, (channelId) =>
        peerSyncFor(LISTENER).receiveBundle({
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
      offerSource(targetProject, worktreeId, (channelId) =>
        peerSyncFor(LISTENER).receiveWorktree({
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
      runHost(
        worktreesOverWire.delete({ projectId: sourceProjectId, worktreeId }),
      ),
    (error) => error instanceof CommandRefusedError,
  );
});

it("a capture over the link snapshots the worktree to its capture ref with its tree, and ignoredPaths names the file it leaves out", async () => {
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
  const capture = await withPeerSource(worktreeRef, (source) => source.capture);
  assert.equal(capture.captured, true, "capture reported clean");
  captureTip = await gitOut(sourceRepo, "rev-parse", dirtyRef);
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
  const ignored = await runHost(
    sync.ignoredPaths({
      projectId: sourceProjectId,
      worktreeId,
    }),
  );
  assert.deepEqual(ignored, {
    paths: ["secret.env"],
    patterns: ["secret.env"],
    total: 1,
  });
});

it("granted transfer: a >2.5 MB bundle crosses as channel frames with its progress, and lands only under refs/shigomori/ with byte-identical objects", async () => {
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
  const progressed: [number, number][] = [];
  const { fetched } = await withPeerSource(worktreeRef, (source) =>
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
  const blob = (repo: string) =>
    gitBytes(repo, ["cat-file", "blob", `${featureTip}:big.bin`]);
  const [sourceBlob, targetBlob] = await Promise.all([
    blob(sourceRepo),
    blob(targetRepo),
  ]);
  assert.equal(sourceBlob.length, 2_700_000);
  assert.ok(
    Buffer.compare(sourceBlob, targetBlob) === 0,
    "transferred blob differs byte-for-byte",
  );
});

it("lifecycle: finished links are gone at both ends, a channel id is single use, a requester giving up mid-bundle leaves the source no temp file, and an ask outside the allowlist resets the link", async () => {
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
  const mux = await toListener.channels();
  const manualLink = async (channelId = mintHexId()) => {
    const link = attachLink((endpoint) => mux.attach(channelId, endpoint));
    await runHost(sync.openSource({ ...worktreeRef, channelId }));
    return { channelId, link };
  };
  const first = await manualLink();
  await assert.rejects(
    () =>
      runHost(sync.openSource({ ...worktreeRef, channelId: first.channelId })),
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
    await Effect.runPromise(
      giving.link.write({
        ask: "bundle",
        refs: ["refs/heads/huge"],
        haves: [baseSha],
      }),
    );
    const header = Schema.decodeUnknownSync(BundleAnswerSchema)(
      await Effect.runPromise(giving.link.read),
    );
    assert.ok(header.bundle.bytes > 5_000_000, "the huge bundle is small");
    await waitFor(
      () => syncTempDirs(tmp).length === 1,
      "the source to hold its bundle while it sends",
    );
    // Reading none of it, the source stalls on the window, then this side
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
  await Effect.runPromise(
    bad.link.write({ ask: "bundle", refs: ["refs/tags/v1"], haves: [] }),
  );
  await assert.rejects(
    () => Effect.runPromise(bad.link.read),
    new RegExp(LINK_GONE),
  );
});

// ---- What runs past a call, held by the host's moves (Moves.fork):
// a source's serving, a send's wait on the peer's answer and the undo
// of an answer that came after a cancel.
describe("serving past the call", () => {
  const caller = handlerCtx();
  const runMove = <A, E>(key: string, move: Effect.Effect<A, E, Services>) => {
    const running = runHost(
      Effect.flatMap(Moves.Moves, (moves) => moves.run(caller, key, move)),
    );
    running.catch(() => {});
    return running;
  };
  const cancel = (key: string) =>
    runHost(Effect.flatMap(Moves.Moves, (moves) => moves.cancel(caller, key)));
  let tmp: string;
  let tmpBefore: string | undefined;
  beforeAll(() => {
    tmp = join(sandbox, "tmp-serving");
    mkdirSync(tmp);
    tmpBefore = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
  });
  afterAll(() => {
    if (tmpBefore === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpBefore;
    onPeerOpen = () => Effect.void;
  });

  it("a send cancelled mid-bundle is under way until the peer has answered, and leaves no temp dir and no channel", async () => {
    // The peer asks for the huge bundle, reads none of it, and answers
    // only once the link is gone and `answer` opens.
    const answer = Deferred.makeUnsafe<void>();
    let channel: string | undefined;
    let answered = false;
    onPeerOpen = (channelId, ctx) =>
      Effect.gen(function* () {
        channel = channelId;
        const link = attachLinkFarEnd(ctx, channelId);
        yield* Effect.ignore(
          Effect.andThen(
            link.write({
              ask: "bundle",
              refs: ["refs/heads/huge"],
              haves: [baseSha],
            }),
            link.read,
          ),
        );
        yield* Deferred.await(link.closed);
        yield* Deferred.await(answer);
        answered = true;
      });
    const source = await findProjectOrThrow(sourceProjectId);
    const sending = runMove(
      "serving-cancelled",
      offer(LISTENER, source, worktreeId, (channelId) =>
        forwardOverWire.open({ port: 1, channelId }),
      ),
    );
    await waitFor(
      () => syncTempDirs(tmp).length === 1,
      "the send to hold its bundle while the peer stalls",
    );
    assert.equal(await cancel("serving-cancelled"), true);
    await assert.rejects(sending, /The move was cancelled/);
    assert.equal(syncTempDirs(tmp).length, 0, "the bundle's temp dir stayed");
    assert.ok(channel !== undefined && !observed.has(channel));
    assert.equal(
      await movesUnderWay(),
      true,
      "the peer's answer still to come reads as nothing under way",
    );
    Deferred.doneUnsafe(answer, Exit.void);
    await waitFor(async () => !(await movesUnderWay()), "the send to be over");
    assert.equal(answered, true);
  });

  it("an answer that came after the cancel is undone before nothing reads under way", async () => {
    const answer = Deferred.makeUnsafe<void>();
    const undo = Deferred.makeUnsafe<void>();
    let asked = false;
    let undoing = false;
    let undone = false;
    onPeerOpen = (channelId, ctx) =>
      Effect.gen(function* () {
        attachLinkFarEnd(ctx, channelId);
        asked = true;
        yield* Deferred.await(answer);
      });
    const source = await findProjectOrThrow(sourceProjectId);
    const sending = runMove(
      "late-answer",
      offer(
        LISTENER,
        source,
        worktreeId,
        (channelId) => forwardOverWire.open({ port: 1, channelId }),
        undefined,
        () =>
          Effect.gen(function* () {
            undoing = true;
            yield* Deferred.await(undo);
            undone = true;
          }),
      ),
    );
    await waitFor(() => asked, "the peer to be asked");
    assert.equal(await cancel("late-answer"), true);
    await assert.rejects(sending, /The move was cancelled/);
    Deferred.doneUnsafe(answer, Exit.void);
    await waitFor(() => undoing, "the late answer's undo to start");
    assert.equal(
      await movesUnderWay(),
      true,
      "a late answer's undo still running reads as nothing under way",
    );
    Deferred.doneUnsafe(undo, Exit.void);
    await waitFor(async () => !(await movesUnderWay()), "the undo to be over");
    assert.equal(undone, true);
  });

  it("the host's moves closing mid-bundle ends the serving, its temp dir and its channel", async () => {
    // The listener's openSource on moves of this proof's own, closed as
    // the graph closes them, the link it serves left up.
    const scope = Scope.makeUnsafe();
    const moves = await runHost(
      Layer.buildWithScope(Layer.fresh(Moves.layer), scope),
    );
    const services = Context.merge(await hostContext(), moves);
    onPeerOpen = (channelId, ctx) =>
      syncHandlers
        .openSource({ ...worktreeRef, channelId }, ctx)
        .pipe(Effect.orDie, Effect.provideContext(services));
    const mux = await toListener.channels();
    const channelId = mintHexId();
    const link = attachLink((endpoint) => mux.attach(channelId, endpoint));
    try {
      await runHost(forwardOverWire.open({ port: 1, channelId }));
      await Effect.runPromise(
        link.write({
          ask: "bundle",
          refs: ["refs/heads/huge"],
          haves: [baseSha],
        }),
      );
      await Effect.runPromise(link.read);
      await waitFor(
        () => syncTempDirs(tmp).length === 1,
        "the source to hold its bundle while it sends",
      );
      // The serve reads as the peer bringing from here, not as a move.
      const underWay = await Effect.runPromise(
        Effect.flatMap(Moves.Moves, (held) => held.underWay).pipe(
          Effect.provideContext(moves),
        ),
      );
      assert.equal(underWay.moving, false);
      assert.equal(underWay.bringing.length, 1);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await waitFor(
        () => syncTempDirs(tmp).length === 0 && !mux.has(channelId),
        "the serving to end with the moves that held it",
        10_000,
      );
    } finally {
      link.reset();
    }
  });
});

it('corrupted bundle: unpack fails with the coded "bad-bundle" error', async () => {
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
});

it("push: a >2.5 MB bundle crosses on a link the pusher opened and lands under refs/shigomori/ on the peer", async () => {
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
    targetProject,
    worktreeIdFromPath(targetRepo),
    (channelId) =>
      peerSyncFor(LISTENER).receiveBundle({
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
});

it("pull round trip (clean): the branch crosses the direct wire and the worktree lands on it, its title and description with it, with the incoming ref swept", async () => {
  // ---- The pull orchestration, end to end. The handler runs HERE
  // as the dialer (the registered surface above is the listener's), with its two
  // real seams injected: the engine (already up) and the peer
  // reach, which is the SAME direct wire and channels the transfer
  // tests drove. Everything in between -- the tip, the
  // capture, the bundle, `sm create`, the capture re-key, `sm dirty
  // apply` -- is production code against real git.
  standInPeers({
    transportFor: (deviceId) => {
      assert.equal(
        deviceId,
        LISTENER,
        "a peer call dialed an unexpected device",
      );
      return {
        ...toListener.transport,
        invoke: async (channel, input, options) => {
          // No mirror is asked for here (that is control.mts's).
          if (channel.startsWith("mirror:")) {
            throw new Error("this proof asks for no mirror");
          }
          // The title's carry. Both devices share the data dir, so the listener's
          // handlers answer in-process.
          if (channel === "worktreeData:read") {
            return runHost(
              worktreeDataHandlers.read(
                input as Parameters<typeof worktreeDataHandlers.read>[0],
              ),
            );
          }
          if (channel === "worktreeData:describe") {
            return runHost(
              worktreeDataHandlers.describe(
                input as Parameters<typeof worktreeDataHandlers.describe>[0],
              ),
            );
          }
          return toListener.transport.invoke(channel, input, options);
        },
      };
    },
    channelsFor: (deviceId) => {
      assert.equal(deviceId, LISTENER, "the move dialed an unexpected device");
      return observed.channels;
    },
  });
  pullCtx = handlerCtx();
  const repoIdentity = await repoIdentityOf(sourceRepo);
  assert.ok(repoIdentity, "fixture repos should carry a non-null identity");
  identity = repoIdentity;
  assert.equal(
    identity,
    await repoIdentityOf(targetRepo),
    "clone and source must share a repo identity",
  );

  // (6) Branch-transfer path: a clean worktree on a branch whose tip
  // the receiver lacks. The branch crosses as a thin bundle, the
  // worktree lands on it, and the incoming ref is swept.
  await writeWorktreeDescription(
    sourceProjectId,
    worktreeIdFromPath(worktree2Path),
    { title: "Second feature", description: "What it does.", describedAt: 7 },
  );
  // Every span the pull makes, on both devices.
  spans.length = 0;
  cleanPull = await runHost(
    syncHandlers
      .pullWorktree(
        {
          sourceDeviceId: LISTENER,
          sourceProjectId,
          sourceWorktreeId: worktreeIdFromPath(worktree2Path),
          sourceIdentity: identity,
          branch: "feature2",
        },
        pullCtx,
      )
      .pipe(Effect.withTracer(tracer)),
  );
  // One trace: the source's answers, served on the listener for the link the dialer's pull
  // opened, continue the pull's trace.
  const pull = spans.find((span) => span.name === "Sync.pull");
  const answers = spans.filter((span) => span.name === "SourceLink.answer");
  assert.ok(pull !== undefined, "the pull made no span");
  assert.ok(answers.length > 0, "the source answered under no span");
  for (const answer of answers) assert.equal(answer.traceId, pull.traceId);
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
  assert.deepEqual(
    await readWorktreeData(cleanPull.worktree.projectId, cleanPull.worktree.id),
    { title: "Second feature", description: "What it does.", describedAt: 7 },
    "the pull must carry the title and description onto the copy",
  );
});

it("mirror: the title and description follow whichever side was described last, and a tie settles on this side", async () => {
  // A mirror's two sides keep whichever pair was described last,
  // each way round, and an equal pair moves nothing.
  const copy = {
    projectId: cleanPull.worktree.projectId,
    worktreeId: cleanPull.worktree.id,
  };
  const original = {
    projectId: sourceProjectId,
    worktreeId: worktreeIdFromPath(worktree2Path),
  };
  await writeWorktreeDescription(original.projectId, original.worktreeId, {
    title: "Renamed there",
    describedAt: 9,
  });
  await followDescription(LISTENER, copy, original);
  assert.deepEqual(await readWorktreeData(copy.projectId, copy.worktreeId), {
    title: "Renamed there",
    describedAt: 9,
  });
  await writeWorktreeDescription(copy.projectId, copy.worktreeId, {
    title: "Renamed here",
    description: "And described.",
    describedAt: 12,
  });
  await followDescription(LISTENER, copy, original);
  assert.deepEqual(
    await readWorktreeData(original.projectId, original.worktreeId),
    {
      title: "Renamed here",
      description: "And described.",
      describedAt: 12,
    },
  );
  // Described in the same millisecond, differently: this side
  // (the original) wins, and both settle on it.
  await writeWorktreeDescription(copy.projectId, copy.worktreeId, {
    title: "Tie here",
    describedAt: 20,
  });
  await writeWorktreeDescription(original.projectId, original.worktreeId, {
    title: "Tie there",
    describedAt: 20,
  });
  await followDescription(LISTENER, copy, original);
  assert.deepEqual(
    await readWorktreeData(original.projectId, original.worktreeId),
    { title: "Tie here", describedAt: 21 },
  );
  assert.deepEqual(await readWorktreeData(copy.projectId, copy.worktreeId), {
    title: "Tie here",
    describedAt: 21,
  });
});

it("mirror: a describe on a device whose clock is behind its peer's still outranks the peer's", async () => {
  const copy = {
    projectId: cleanPull.worktree.projectId,
    worktreeId: cleanPull.worktree.id,
  };
  const original = {
    projectId: sourceProjectId,
    worktreeId: worktreeIdFromPath(worktree2Path),
  };
  const clocks = sleepingClock(testClock());
  clocks.sleep(1_000_000);
  // Described on the peer, whose clock runs five minutes ahead.
  await writeWorktreeDescription(original.projectId, original.worktreeId, {
    title: "Ahead there",
    describedAt: 1_000_000 + 300_000,
  });
  assert.equal(await followDescription(LISTENER, copy, original), "here");
  // Described here a minute later, by a clock that also stepped back.
  clocks.sleep(-60_000);
  await runHost(
    Effect.provideService(
      worktreesHandlers.describe({ ...copy, title: "Behind here" }),
      Clock.Clock,
      clocks.wall,
    ),
  );
  assert.equal(await followDescription(LISTENER, copy, original), "there");
  for (const side of [copy, original]) {
    assert.equal(
      (await readWorktreeData(side.projectId, side.worktreeId))?.title,
      "Behind here",
    );
  }
});

it("pull round trip (dirty): no branch bundle for a locally-known tip, and the capture is re-keyed, applied unstaged, and consumed", async () => {
  // (7) Dirty + tip-already-local path: scratch sits at the base
  // commit the receiver already holds, so no branch bundle crosses;
  // the fresh capture does, gets re-keyed from the source worktree id
  // to the new local one, and lands unstaged.
  const dirtyPull = await pullWorktree(
    {
      sourceDeviceId: LISTENER,
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
    const survived = await refExists(targetRepo, ref);
    assert.equal(survived, false, `${ref} survived the pull`);
  }
});

it("pull refusals: an already-existing branch and an unmatched repo identity both refuse up front", async () => {
  // (8) The update-existing case is out of scope by design: a second
  // pull of the same branch refuses up front with the actionable
  // message, before touching the peer.
  await assert.rejects(
    async () =>
      pullWorktree(
        {
          sourceDeviceId: LISTENER,
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
    async () =>
      pullWorktree(
        {
          sourceDeviceId: LISTENER,
          sourceProjectId,
          sourceWorktreeId: worktreeId,
          sourceIdentity: "root:0000000000000000000000000000000000000000",
          branch: "scratch-two",
        },
        pullCtx,
      ),
    /No local project matches/,
  );
  assert.deepEqual(
    await changesUnderWay(),
    [],
    "a refused pull leaves nothing counted",
  );
});

it("a pull whose source can't make its temporary files is answered with why, not left waiting", async () => {
  // A commit the target lacks, so the source has a capture and a
  // bundle to make, each in a temporary folder.
  const wtPath = await addWorktree(sourceRepo, "wt-no-tmp", "no-tmp", "n.txt");
  // Nowhere to make a temporary folder: a disk that's full, or one the
  // app may not write.
  const tmp = process.env["TMPDIR"];
  process.env["TMPDIR"] = join(sandbox, "no-such-tmp");
  try {
    await assert.rejects(
      pullWorktree(
        {
          sourceDeviceId: LISTENER,
          sourceProjectId,
          sourceWorktreeId: worktreeIdFromPath(wtPath),
          sourceIdentity: identity,
          branch: "no-tmp",
        },
        pullCtx,
      ),
      /Couldn't capture the worktree's uncommitted changes: no such file or directory\./,
    );
  } finally {
    if (tmp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = tmp;
  }
}, 60_000);

it("transplant (clean): the worktree lands here and the source worktree, its sm data, and its branch are torn down", async () => {
  // ---- The transplant: the pull above plus tearing the
  // source worktree down on the listener through its wire-served
  // worktrees:delete, gated by the pull's receipt. Fresh worktrees
  // per scenario, since the earlier tests consumed wt and wt2.

  // (9) Clean transplant: the branch crosses, the worktree lands, and
  // the SOURCE side loses the worktree directory, its sm worktree
  // data, and the branch. A MANAGED worktree (sm create, the realistic
  // transplant source): `sm rm` only deletes the branch for managed
  // worktrees, and the sandbox's unset DeleteBranchOnRemove defaults
  // to delete (Worktrees.remove in the engine).
  const wt3Create = await sm(
    "create",
    "--project-id",
    sourceProjectId,
    "--branch",
    "feature3",
  );
  const wt3Doc = wt3Create.docs.find((doc) => doc.event === "created");
  assert.ok(wt3Doc, "sm create emitted no created doc");
  const wt3 = Schema.decodeUnknownSync(WorktreeSchema)(wt3Doc.worktree);
  const wt3Path = wt3.path;
  wt3Id = wt3.id;
  await commitFile(wt3Path, "third.txt", "third feature\n", "third feature");
  const feature3Tip = await gitOut(wt3Path, "rev-parse", "HEAD");
  // Seed the worktree's own data (the ports the app keeps), so the
  // teardown's sweep of it is observable.
  await writeWorktreeData(sourceProjectId, wt3Id, { ports: [{ port: 4321 }] });
  const cleanTransplant = await transplant({
    sourceDeviceId: LISTENER,
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
    await readWorktreeData(sourceProjectId, wt3Id),
    null,
    "the source sm worktree data must be gone",
  );
  assert.equal(
    await refExists(sourceRepo, "refs/heads/feature3"),
    false,
    "the source branch must be deleted (DeleteBranchOnRemove default)",
  );
});

it("transplant (dirty): the capture lands applied and force removes the still-dirty source worktree", async () => {
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
    sourceDeviceId: LISTENER,
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
  ] as const) {
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
});

it("transplant (scripts running): the teardown refuses, saying the scripts still run, and the source survives", async () => {
  // (11) Scripts-running refusal: a live script in the source worktree
  // makes the teardown refuse (never kill), so the pull half succeeds
  // and the source survives with the worktree on both sides.
  const wt5Path = await addWorktree(sourceRepo, "wt5", "feature5");
  const wt5Id = worktreeIdFromPath(wt5Path);
  // A REAL long-lived script through the app's registry (the registry
  // is what the refusal flag consults), reaped in the finally below.
  const scripts = await runHost(Scripts.Scripts);
  await runHost(
    scripts.start({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      slot: { kind: "package", name: "sleep" },
      worktree: { id: wt5Id, name: "wt5", branch: "feature5", path: wt5Path },
      project: { id: sourceProjectId, path: sourceRepo, name: "source" },
      scriptEnv: {
        projectBranch: "main",
        defaultBranch: "main",
        title: "",
        description: "",
      },
      notify: () => {},
    }),
  );
  try {
    const refusedTransplant = await transplant({
      sourceDeviceId: LISTENER,
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
      /^1 script is still running there\.$/,
    );
    assert.equal(
      existsSync(wt5Path),
      true,
      "the source worktree must survive a refused teardown",
    );
    assert.equal(
      scripts.worktrees().some((w) => w.worktreeId === wt5Id),
      true,
      "the refused teardown must leave the source's scripts running",
    );
  } finally {
    await runHost(scripts.stopWorktree(wt5Id));
  }
});

it("teardownSource: refuses without a receipt, refuses a source that changed after the pull, and removes it once it matches again", async () => {
  // (12) The receipt gate: a teardown for a worktree this device never
  // pulled refuses before dialing the peer. A receipt serves exactly
  // one successful teardown. A source that changed after the pull
  // (edits after the capture, or a moved tip) keeps its copy until it
  // matches the receipt again.
  await assert.rejects(
    async () =>
      runHost(
        syncHandlers.teardownSource(
          {
            direction: "pull",
            deviceId: LISTENER,
            projectId: sourceProjectId,
            worktreeId: "0123456789ab",
          },
          pullCtx,
        ),
      ),
    /No pull recorded/,
  );
  await assert.rejects(
    async () =>
      runHost(
        syncHandlers.teardownSource(
          {
            direction: "pull",
            deviceId: LISTENER,
            projectId: sourceProjectId,
            worktreeId: wt3Id,
          },
          pullCtx,
        ),
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
  const wt6Source: SyncMoveRef = {
    direction: "pull",
    deviceId: LISTENER,
    projectId: sourceProjectId,
    worktreeId: wt6Id,
  };
  const latePull = await pullWorktree(
    {
      sourceDeviceId: LISTENER,
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
  const refusedLate = await runHost(
    syncHandlers.teardownSource(wt6Source, pullCtx),
  );
  assert.equal(refusedLate.sourceRemoved, false);
  assert.match(refusedLate.sourceError ?? "", /changed after/);
  assert.equal(existsSync(wt6Path), true, "a changed source must survive");
  // Back to exactly the captured state, the receipt matches again.
  writeFileSync(join(wt6Path, "draft.txt"), "draft\n");
  const lateTeardown = await runHost(
    syncHandlers.teardownSource(wt6Source, pullCtx),
  );
  assert.equal(lateTeardown.sourceRemoved, true, lateTeardown.sourceError);
  assert.equal(existsSync(wt6Path), false);
});

it("teardownSource: a source edited while its cleanup runs is kept, the check made again right before the delete", async () => {
  // The receipt matches when the teardown starts. Its teardown script
  // then waits on a gate, and an editor writes to the source meanwhile.
  // A managed worktree: only those run their cleanup.
  const wt8Create = await sm(
    "create",
    "--project-id",
    sourceProjectId,
    "--branch",
    "feature8",
  );
  const wt8Doc = wt8Create.docs.find((doc) => doc.event === "created");
  assert.ok(wt8Doc, "sm create emitted no created doc");
  const wt8 = Schema.decodeUnknownSync(WorktreeSchema)(wt8Doc.worktree);
  const wt8Path = wt8.path;
  const wt8Id = wt8.id;
  await commitFile(wt8Path, "eighth.txt", "eighth\n", "eighth feature");
  writeFileSync(join(wt8Path, "draft.txt"), "draft\n");
  const pulled = await pullWorktree(
    {
      sourceDeviceId: LISTENER,
      sourceProjectId,
      sourceWorktreeId: wt8Id,
      sourceIdentity: identity,
      branch: "feature8",
    },
    pullCtx,
  );
  assert.equal(pulled.dirtyApplied, true);
  const gate = join(sourceRepo, "..", "teardown-gate");
  mkdirSync(gate, { recursive: true });
  const started = join(gate, "started");
  const release = join(gate, "release");
  const before: ShigomoriConfig | null =
    await readShigomoriConfig(sourceProjectId);
  await writeProjectConfig(sourceProjectId, {
    ...before,
    defaultBranch: "main",
    scripts: {
      teardown: `touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.05; done`,
    },
  });
  let torn: Promise<unknown> | undefined;
  try {
    const tearing = runHost(
      syncHandlers.teardownSource(
        {
          direction: "pull",
          deviceId: LISTENER,
          projectId: sourceProjectId,
          worktreeId: wt8Id,
        },
        pullCtx,
      ),
    );
    torn = tearing;
    await waitFor(() => existsSync(started), "the teardown script to start");
    writeFileSync(join(wt8Path, "draft.txt"), "draft, edited meanwhile\n");
    writeFileSync(release, "");
    const result = await tearing;
    assert.equal(result.sourceRemoved, false);
    assert.match(result.sourceError ?? "", /changed after it was moved/);
    assert.equal(
      readFileSync(join(wt8Path, "draft.txt"), "utf8"),
      "draft, edited meanwhile\n",
      "the edit made during the cleanup must survive",
    );
  } finally {
    // Released whatever failed, so no teardown script waits on.
    writeFileSync(release, "");
    await torn?.catch(() => undefined);
    await writeProjectConfig(
      sourceProjectId,
      before ?? { defaultBranch: "main" },
    );
    rmSync(gate, { recursive: true, force: true });
  }
});

it("sendWorktree: a dirty worktree lands on the peer with its commit and its uncommitted work and the peer's progress relayed, a repeat is refused by the peer, and the teardown removes the local source only while it still matches what was sent", async () => {
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
    targetDeviceId: LISTENER,
    projectId: sourceProjectId,
    worktreeId: worktreeIdFromPath(wt7Path),
  };
  const wt7Sent: SyncMoveRef = {
    direction: "send",
    deviceId: LISTENER,
    projectId: sourceProjectId,
    worktreeId: wt7.worktreeId,
  };
  // The peer's frames, relayed here under the local worktree's id.
  const sendRaw: unknown[] = [];
  const sendCtx = handlerCtx({
    notifier: () => (frame) => {
      sendRaw.push(frame);
    },
  });
  await assert.rejects(
    async () => runHost(syncHandlers.teardownSource(wt7Sent, pullCtx)),
    /No send recorded/,
  );
  const sent = await sendWorktreeHere(wt7, sendCtx);
  const sendFrames = decodePullProgresses(sendRaw);
  assert.ok(
    sendFrames.every((frame) => frame.sourceWorktreeId === wt7.worktreeId),
  );
  const sentSteps = new Set<string>(sendFrames.map((frame) => frame.step));
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
    "the peer's incoming ref must be swept",
  );
  // A second send meets the branch the first one landed, refused by
  // the peer before a byte moves and attributed to it.
  await assert.rejects(
    async () => sendWorktreeHere(wt7, pullCtx),
    /The other device answered: feature7 is already checked out/,
  );
  assert.deepEqual(
    await changesUnderWay(),
    [],
    "a refused send leaves nothing counted",
  );
  writeFileSync(join(wt7Path, "draft.txt"), "sent draft, then edited\n");
  const keptSent = await runHost(syncHandlers.teardownSource(wt7Sent, pullCtx));
  assert.equal(keptSent.sourceRemoved, false);
  assert.match(keptSent.sourceError ?? "", /changed after/);
  assert.equal(existsSync(wt7Path), true, "a changed source must survive");
  writeFileSync(join(wt7Path, "draft.txt"), "sent draft\n");
  const tornSent = await runHost(syncHandlers.teardownSource(wt7Sent, pullCtx));
  assert.equal(tornSent.sourceRemoved, true, tornSent.sourceError);
  assert.equal(existsSync(wt7Path), false);
});

it("a send whose rule brings the ignored files leaves the peer project's carry-over to them, and one that brings none seeds it", async () => {
  // The worktree's own ignored files follow it (the files step after
  // the create), so the destination's carry-over must not seed them
  // first: the files step keeps what is already there.
  writeFileSync(
    join(targetRepo, ".git", "info", "exclude"),
    "CLAUDE.local.md\n",
  );
  writeFileSync(join(targetRepo, "CLAUDE.local.md"), "target's\n");
  await writeProjectConfig(targetProjectId, {
    ...(await readShigomoriConfig(targetProjectId)),
    defaultBranch: "main",
    carryOver: [{ path: "CLAUDE.local.md", mode: "copy" }],
  });
  const landedWith = async (
    name: string,
    rule: { ignoreMode: "everything" | "gitignored"; ignores: string[] },
  ) => {
    const path = await addWorktree(
      sourceRepo,
      name,
      name,
      `${name}.txt`,
      `${name}\n`,
      name,
    );
    const sent = await sendWorktreeHere(
      {
        targetDeviceId: LISTENER,
        projectId: sourceProjectId,
        worktreeId: worktreeIdFromPath(path),
        ...rule,
      },
      handlerCtx(),
    );
    return sent.worktree.path;
  };
  // A files step that settles at once, carrying nothing.
  standInMirror(
    inertMirrorImpl({
      create: () => Effect.succeed("carry-files"),
      sessions: Effect.succeed([
        rawMirrorSession({ session: "carry-files", successfulCycles: 1 }),
      ]),
      terminate: () => Effect.void,
    }),
  );
  try {
    const brought = await landedWith("carry-brought", {
      ignoreMode: "everything",
      ignores: [],
    });
    assert.equal(existsSync(join(brought, "CLAUDE.local.md")), false);
  } finally {
    standInMirror(inertMirrorImpl());
  }
  const seeded = await landedWith("carry-seeded", {
    ignoreMode: "gitignored",
    ignores: [],
  });
  assert.equal(
    readFileSync(join(seeded, "CLAUDE.local.md"), "utf8"),
    "target's\n",
  );
});

it("sendWorktree from a primary: refuses a branch named mirror in the way, then lands on the peer as a worktree on mirror/<branch> with the tip and the uncommitted work, its primary untouched", async () => {
  // ---- A primary checkout, sent the way the mirror start sends it:
  // the copy is an ordinary worktree on mirror/<branch> carrying the
  // branch's commits and uncommitted work, and the target's own
  // primary (on main) is untouched. The source's primary moves one
  // commit ahead of the target's, then onto a fresh branch.
  await commitFile(sourceRepo, "ff.txt", "from main\n", "main moves on");
  mainTip = await gitOut(sourceRepo, "rev-parse", "HEAD");
  const targetMainBefore = await gitOut(targetRepo, "rev-parse", "HEAD");
  await git(sourceRepo, ["checkout", "-q", "-b", "primary-branch"]);
  writeFileSync(join(sourceRepo, "sent-draft.txt"), "sent from primary\n");
  const primarySend = {
    targetDeviceId: LISTENER,
    projectId: sourceProjectId,
    worktreeId: worktreeIdFromPath(sourceRepo),
  };
  // A plain send refuses the primary (it is the project itself). The
  // mirror start's send takes it.
  await assert.rejects(
    async () => sendWorktreeHere(primarySend, pullCtx),
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
});

it("cloneProjectFromPeer: the peer's default branch lands as a registered checkout of the same identity with its remote and progress reported, a taken folder, a parent that is a file and a landing on the default branch are refused clean, and a pull with cloneInto beside a checkout it has clones nothing", async () => {
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
  const cloneFrom = (
    into: SyncCloneInto,
    landing: string,
    onProgress?: (bytes: number, totalBytes: number) => void,
  ) =>
    withPeerSource(
      {
        projectId: sourceProjectId,
        worktreeId: worktreeIdFromPath(sourceRepo),
      },
      (source) =>
        cloneCheckoutFromPeer(
          source,
          into,
          landing,
          identity,
          Projects.addProject,
          onProgress,
        ),
    );
  // What a clone a crash cut short left: swept by the next of its name.
  mkdirSync(join(clonesDir, ".lone.partial-4194304"), { recursive: true });
  writeFileSync(join(clonesDir, ".lone.partial-4194304", "half"), "");
  const cloneFrames: [number, number][] = [];
  const cloned = await cloneFrom(
    { parentDir: clonesDir, name: "lone" },
    "feat/landing",
    (bytes, totalBytes) => cloneFrames.push([bytes, totalBytes]),
  );
  assert.equal(cloned.path, join(clonesDir, "lone"));
  assert.deepEqual(
    readdirSync(clonesDir).filter((entry) => entry.includes(".partial-")),
    [],
    "the clone is built beside its folder and renamed in, a dead one's sibling swept",
  );
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
    await repoIdentityOf(cloned.path),
    identity,
    "the clone must read as the same repo",
  );
  const [firstFrame] = cloneFrames;
  assert.ok(
    firstFrame !== undefined && cloneFrames.length >= 2,
    "the clone reported no progress",
  );
  const [, total] = firstFrame;
  assert.deepEqual(firstFrame, [0, total]);
  assert.deepEqual(cloneFrames.at(-1), [total, total]);
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
  // One whose fetch fails after its sibling was made leaves neither the
  // sibling nor the folder, and registers nothing.
  await assert.rejects(() =>
    withPeerSource(
      {
        projectId: sourceProjectId,
        worktreeId: worktreeIdFromPath(sourceRepo),
      },
      (source) =>
        cloneCheckoutFromPeer(
          {
            ...source,
            fetch: () =>
              Effect.fail(new Git.GitRefusedError({ reason: "cut off" })),
          },
          { parentDir: clonesDir, name: "cut" },
          "feat/landing",
          identity,
          Projects.addProject,
        ),
    ),
  );
  assert.deepEqual(
    readdirSync(clonesDir).filter((entry) => entry.includes("cut")),
    [],
  );
  assert.equal((await listProjects()).length, before);
  // One whose register never ran (a crash right after the rename, here a
  // register that fails) is left whole, and the next clone of that folder
  // registers it.
  const lateSource = {
    projectId: sourceProjectId,
    worktreeId: worktreeIdFromPath(sourceRepo),
  };
  const lateInto = { parentDir: clonesDir, name: "late" };
  await assert.rejects(() =>
    withPeerSource(lateSource, (source) =>
      cloneCheckoutFromPeer(source, lateInto, "feat/landing", identity, () =>
        Effect.fail(new Git.GitRefusedError({ reason: "the host went away" })),
      ),
    ),
  );
  assert.ok(existsSync(join(clonesDir, "late", ".git", "sm-clone-pending")));
  assert.equal((await listProjects()).length, before);
  // Another repo asked into that folder takes nothing of it.
  await assert.rejects(
    () =>
      withPeerSource(lateSource, (source) =>
        cloneCheckoutFromPeer(
          source,
          lateInto,
          "feat/landing",
          "another-repo",
          Projects.addProject,
        ),
      ),
    /already exists/,
  );
  assert.equal((await listProjects()).length, before);
  const late = await withPeerSource(lateSource, (source) =>
    cloneCheckoutFromPeer(
      source,
      lateInto,
      "feat/landing",
      identity,
      Projects.addProject,
    ),
  );
  assert.equal(late.path, join(clonesDir, "late"));
  assert.ok(!existsSync(join(clonesDir, "late", ".git", "sm-clone-pending")));
  assert.equal((await listProjects()).length, before + 1);
  // A pull told where to clone beside a checkout it already has
  // takes the checkout: nothing is cloned and the result says so.
  const wtBesidePath = await addWorktree(sourceRepo, "wt-beside", "beside");
  const beside = await pullWorktree(
    {
      sourceDeviceId: LISTENER,
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
});

// ---- The cancel (sync:cancelMove, host/lib/sync/Moves.ts): a move
// cut short mid-create, with the target's setup script hung, ends
// within moments with the script dead, the worktree it made
// removed, the branch (kept by `sm rm` under the setting) and
// incoming ref gone and the source untouched. Once over, there is nothing left to cancel. The same
// for a send, where the landing runs on the peer and meets the
// cancel as the link torn down under it, for a caller that goes
// away (its call interrupted), which cancels like a click, and for a
// cancel after the landing committed (the files step), which still
// takes the copy.
describe("cancelMove", () => {
  let targetConfigBefore: ShigomoriConfig | null;
  const setupPidPath = join(sandbox, "setup.pid");
  // The setup script has started: its pid is in the file, and it is
  // the sleep (exec'd, so the pid is the one process to watch). The
  // shell makes the file before echo writes the pid into it.
  const setupPid = () => {
    if (!existsSync(setupPidPath)) return undefined;
    const pid = Number(readFileSync(setupPidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  };
  const setupStarted = async () => {
    if (existsSync(setupPidPath)) rmSync(setupPidPath);
    await waitFor(
      () => setupPid() !== undefined,
      "the target's setup script to start",
      60_000,
    );
    const pid = setupPid();
    assert.ok(pid !== undefined, "no setup pid");
    return pid;
  };
  const landedNothing = async (branch: string, sourcePath: string) => {
    assert.equal(
      await refExists(targetRepo, `refs/heads/${branch}`),
      false,
      `the cancelled move left ${branch} on the target`,
    );
    assert.equal(
      await refExists(targetRepo, `refs/shigomori/incoming/${branch}`),
      false,
      "the cancelled move left its incoming ref",
    );
    assert.ok(
      !(await gitOut(targetRepo, "worktree", "list", "--porcelain")).includes(
        `branch refs/heads/${branch}`,
      ),
      `the cancelled move left a worktree on ${branch}`,
    );
    assert.equal(existsSync(sourcePath), true, "the source must survive");
  };
  beforeAll(async () => {
    targetConfigBefore = await readShigomoriConfig(targetProjectId);
    await writeProjectConfig(targetProjectId, {
      ...targetConfigBefore,
      defaultBranch: "main",
      scripts: {
        setup: `echo $$ > '${setupPidPath}'; exec sleep 600`,
      },
    });
    // Branches kept on removal, so the rollback has to take the one
    // the move made itself, or a retry would meet it.
    await sm("config", "write", "--data", '{"deleteBranchOnRemove":false}');
  });

  afterAll(async () => {
    await writeProjectConfig(
      targetProjectId,
      targetConfigBefore ?? { defaultBranch: "main" },
    );
    await sm("config", "write", "--data", '{"deleteBranchOnRemove":true}');
  });

  it("cancelMove (pull): the hung setup script dies, the worktree, branch and incoming ref are gone, the source survives, a second cancel finds nothing, and a retry lands", async () => {
    // (a) The pull, cancelled by the caller.
    const wtCancelPath = await addWorktree(sourceRepo, "wt-cancel", "cancel1");
    const wtCancelId = worktreeIdFromPath(wtCancelPath);
    const cancelledPull = Promise.resolve(
      pullWorktree(
        {
          sourceDeviceId: LISTENER,
          sourceProjectId,
          sourceWorktreeId: wtCancelId,
          sourceIdentity: identity,
          branch: "cancel1",
        },
        pullCtx,
      ),
    );
    cancelledPull.catch(() => {});
    const pullSetupPid = await setupStarted();
    assert.equal(processAlive(pullSetupPid), true);
    assert.deepEqual(
      await changesUnderWay(),
      ["bring"],
      "the pull counts as one move for its whole run, its landing in it",
    );
    const cancelledAt = Date.now();
    assert.deepEqual(
      await runHost(
        syncHandlers.cancelMove({ sourceWorktreeId: wtCancelId }, pullCtx),
      ),
      { cancelled: true },
    );
    await assert.rejects(cancelledPull, /The move was cancelled/);
    assert.ok(
      Date.now() - cancelledAt < 20_000,
      "the cancel took longer than the rollback should",
    );
    await waitFor(() => !processAlive(pullSetupPid), "the setup script to die");
    await landedNothing("cancel1", wtCancelPath);
    assert.deepEqual(
      await changesUnderWay(),
      [],
      "a cancelled pull leaves nothing counted",
    );
    assert.deepEqual(
      await runHost(
        syncHandlers.cancelMove({ sourceWorktreeId: wtCancelId }, pullCtx),
      ),
      { cancelled: false },
      "a move that is over is not cancellable",
    );
    // And the source is exactly as it was: the same pull lands.
    const retried = await pullWorktree(
      {
        sourceDeviceId: LISTENER,
        sourceProjectId,
        sourceWorktreeId: wtCancelId,
        sourceIdentity: identity,
        branch: "cancel1",
        runSetup: false,
      },
      pullCtx,
    );
    assert.equal(retried.worktree.branch, "cancel1");
  });

  it("cancelMove (send): the peer's landing is cancelled by the link torn down under it, its setup script dies, the copy goes, and no receipt is kept", async () => {
    // (b) The send: the landing runs on the peer, under the link this
    // side tears down as it cancels.
    const wtCancel2Path = await addWorktree(
      sourceRepo,
      "wt-cancel2",
      "cancel2",
    );
    const wtCancel2Id = worktreeIdFromPath(wtCancel2Path);
    const cancelledSend = Promise.resolve(
      sendWorktreeHere(
        {
          targetDeviceId: LISTENER,
          projectId: sourceProjectId,
          worktreeId: wtCancel2Id,
        },
        pullCtx,
      ),
    );
    cancelledSend.catch(() => {});
    const sendSetupPid = await setupStarted();
    // Both devices share this process, so the peer's landing is counted
    // here too: what this side adds is the send.
    assert.ok(
      (await changesUnderWay()).includes("send"),
      "the send counts for its whole run",
    );
    assert.deepEqual(
      await runHost(
        syncHandlers.cancelMove({ sourceWorktreeId: wtCancel2Id }, pullCtx),
      ),
      { cancelled: true },
    );
    await assert.rejects(cancelledSend, /The move was cancelled/);
    await waitFor(
      () => !processAlive(sendSetupPid),
      "the peer's setup script to die",
    );
    // The peer unwinds on its own after the link drops: the branch goes
    // with the worktree, and the incoming ref after them.
    await waitFor(
      async () =>
        !(await refExists(targetRepo, "refs/heads/cancel2")) &&
        !(await refExists(targetRepo, "refs/shigomori/incoming/cancel2")),
      "the peer to remove the cancelled copy",
      20_000,
    );
    await landedNothing("cancel2", wtCancel2Path);
    await waitFor(
      async () => (await changesUnderWay()).length === 0,
      "a cancelled send to leave nothing counted",
    );
    await assert.rejects(
      async () =>
        runHost(
          syncHandlers.teardownSource(
            {
              direction: "send",
              deviceId: LISTENER,
              projectId: sourceProjectId,
              worktreeId: wtCancel2Id,
            },
            pullCtx,
          ),
        ),
      /No send recorded/,
      "a cancelled send must leave no receipt to tear the source down on",
    );
  });

  it("cancelMove (caller gone): a call interrupted mid-create cancels the move like a click, and leaves nothing behind", async () => {
    // (c) The caller gone: a pull whose call is interrupted (the window
    // reloaded, the socket died) is cancelled the same way, unwound by
    // the time the interrupt returns.
    const wtCancel3Path = await addWorktree(
      sourceRepo,
      "wt-cancel3",
      "cancel3",
    );
    const wtCancel3Id = worktreeIdFromPath(wtCancel3Path);
    const abandonedPull = Effect.runForkWith(await hostContext())(
      syncHandlers.pullWorktree(
        {
          sourceDeviceId: LISTENER,
          sourceProjectId,
          sourceWorktreeId: wtCancel3Id,
          sourceIdentity: identity,
          branch: "cancel3",
        },
        pullCtx,
      ),
    );
    const abandonedSetupPid = await setupStarted();
    await Effect.runPromise(Fiber.interrupt(abandonedPull));
    await waitFor(
      () => !processAlive(abandonedSetupPid),
      "the setup script to die",
    );
    await landedNothing("cancel3", wtCancel3Path);
  });

  it("cancelMove (pull, after its landing committed): a cancel at the files step still takes the copy, its branch and its incoming ref", async () => {
    // (d) Past the landing's commit point (Worktrees.createHeld's keep):
    // the files step, held by a transfer session that never settles.
    const wtCancel4Path = await addWorktree(
      sourceRepo,
      "wt-cancel4",
      "cancel4",
    );
    const wtCancel4Id = worktreeIdFromPath(wtCancel4Path);
    let atFiles!: () => void;
    const reachedFiles = new Promise<void>((resolve) => {
      atFiles = resolve;
    });
    standInMirror(
      inertMirrorImpl({
        create: () =>
          Effect.sync(() => {
            atFiles();
            return "cancel4-files";
          }),
        sessions: Effect.succeed([
          rawMirrorSession({ session: "cancel4-files" }),
        ]),
        terminate: () => Effect.void,
      }),
    );
    try {
      const cancelledPull = Promise.resolve(
        pullWorktree(
          {
            sourceDeviceId: LISTENER,
            sourceProjectId,
            sourceWorktreeId: wtCancel4Id,
            sourceIdentity: identity,
            branch: "cancel4",
            runSetup: false,
            ignoreMode: "everything",
          },
          pullCtx,
        ),
      );
      cancelledPull.catch(() => {});
      await reachedFiles;
      assert.ok(
        await refExists(targetRepo, "refs/heads/cancel4"),
        "the landing answered before the files step",
      );
      assert.deepEqual(
        await runHost(
          syncHandlers.cancelMove({ sourceWorktreeId: wtCancel4Id }, pullCtx),
        ),
        { cancelled: true },
      );
      await assert.rejects(cancelledPull, /The move was cancelled/);
      await landedNothing("cancel4", wtCancel4Path);
    } finally {
      standInMirror(inertMirrorImpl());
    }
  });
});

it("sendWorktree into a device with no checkout: the peer clones the repo from here over the link (progress relayed), registers it, lands the copy in it with its uncommitted work, and the teardown removes the source here", async () => {
  // ---- A send into a device with no checkout of the repo: the peer
  // clones it from here first, over the same link the branch then
  // crosses, and lands the copy in the clone. The two ends need
  // registries of their own for this, or the peer's identity scan
  // finds the sender's own checkout: the sending side's effects run
  // on a second engine over a second data dir (asOtherDevice), where
  // the lone repo is
  // registered. The landing side (the listener, the shared registry) has never
  // seen it.
  const otherDataDir = join(sandbox, "data-other");
  mkdirSync(otherDataDir);
  const otherCli = createCliRunner(fixture.smBinary, {
    ...fixture.smEnv,
    SHIGOMORI_DATA_DIR: otherDataDir,
  });
  const otherEngine = await secondEngine(otherDataDir);
  const otherContext = await otherEngine.context();
  // An effect of the host's, run on the sending device's engine.
  const asOtherDevice = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    runHost(Effect.provide(effect, otherContext));
  try {
    const loneRepo = await fixture.initRepo("lone-source");
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
    const { id: loneProjectId } = await addProject(otherCli.sm, loneRepo);
    const loneWt = {
      targetDeviceId: LISTENER,
      projectId: loneProjectId,
      worktreeId: worktreeIdFromPath(loneWtPath),
    };
    const sentInto = join(sandbox, "clones", "sent");
    const loneRaw: unknown[] = [];
    const loneSent = await asOtherDevice(
      syncHandlers.sendWorktree(
        { ...loneWt, cloneInto: { parentDir: sentInto, name: "lone" } },
        handlerCtx({
          notifier: () => (frame) => {
            loneRaw.push(frame);
          },
        }),
      ),
    );
    const loneFrames = decodePullProgresses(loneRaw);
    assert.ok(loneSent.cloned, "the send made no clone on the peer");
    assert.equal(loneSent.cloned.path, join(sentInto, "lone"));
    assert.equal(
      (await findProjectOrThrow(loneSent.cloned.id)).path,
      loneSent.cloned.path,
      "the clone is registered on the landing side",
    );
    assert.equal(
      await repoIdentityOf(loneSent.cloned.path),
      await repoIdentityOf(loneRepo),
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
    const loneSteps = new Set<string>(loneFrames.map((frame) => frame.step));
    for (const step of ["clone", "capture", "transfer", "create", "apply"]) {
      assert.ok(loneSteps.has(step), `the send never reported ${step}`);
    }
    // Its teardown runs on the sending side, against that side's own
    // registry, on the receipt the peer's landing made.
    const loneTorn = await asOtherDevice(
      syncHandlers.teardownSource(
        {
          direction: "send",
          deviceId: LISTENER,
          projectId: loneProjectId,
          worktreeId: loneWt.worktreeId,
        },
        pullCtx,
      ),
    );
    assert.equal(loneTorn.sourceRemoved, true, loneTorn.sourceError);
    assert.equal(existsSync(loneWtPath), false);
  } finally {
    await otherEngine.close();
  }
});

it("mirror start into a device with no checkout, the project's default branch a remote-tracking ref: the clone checks out the remote's branch at the remote ref's tip, origin/HEAD on it, and the copy lands in the clone", async () => {
  // ---- A project as a laptop has it: a clone with a fetched origin,
  // whose default branch resolves to origin/main with or without a
  // setting (the candidates go remote first, and `projects add` seeds
  // the setting from them), local main lagging behind it, and the rest
  // of the owner's settings. A clone made for the copy checks out main,
  // made of the source's origin/main, not a branch named "origin/main".
  const otherDataDir = join(sandbox, "data-tracking");
  mkdirSync(otherDataDir);
  const otherCli = createCliRunner(fixture.smBinary, {
    ...fixture.smEnv,
    SHIGOMORI_DATA_DIR: otherDataDir,
  });
  const otherEngine = await secondEngine(otherDataDir);
  const otherContext = await otherEngine.context();
  const asOtherDevice = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    runHost(Effect.provide(effect, otherContext));
  try {
    const repo = await fixture.initRepo("tracking-source");
    await commitFile(repo, "root.txt", "root\n", "root");
    await commitFile(repo, "ahead.txt", "on origin\n", "ahead on origin");
    const originTip = await gitOut(repo, "rev-parse", "HEAD");
    await git(repo, [
      "remote",
      "add",
      "origin",
      "https://github.com/example/tracking.git",
    ]);
    await git(repo, ["update-ref", "refs/remotes/origin/main", originTip]);
    await git(repo, ["reset", "--quiet", "--hard", "HEAD~1"]);
    const wtPath = await addWorktree(
      repo,
      "rudy",
      "rudy",
      "rudy.txt",
      "rudy\n",
      "rudy",
    );
    const { id: projectId } = await addProject(otherCli.sm, repo);
    await asOtherDevice(
      Ops.writeProjectConfig(projectId, {
        carryOver: [
          { path: "CLAUDE.local.md", mode: "copy" },
          { path: "app/.env.local", mode: "copy" },
        ],
        defaultBranch: "origin/main",
        lastMergeMethod: "squash",
        scripts: { setup: "printf set > .setup-ran" },
      }),
    );
    const sentInto = join(sandbox, "clones", "tracking");
    const { result: sent } = await asOtherDevice(
      sendWorktreeOn(
        {
          targetDeviceId: LISTENER,
          projectId,
          worktreeId: worktreeIdFromPath(wtPath),
          cloneInto: { parentDir: sentInto, name: "tracking" },
        },
        handlerCtx(),
        { mirror: true },
      ),
    );
    assert.ok(sent.cloned, "the mirror made no clone on the peer");
    const clone = sent.cloned.path;
    assert.equal(
      await gitOut(clone, "symbolic-ref", "HEAD"),
      "refs/heads/main",
    );
    assert.equal(await gitOut(clone, "rev-parse", "HEAD"), originTip);
    assert.equal(
      await gitOut(clone, "symbolic-ref", "refs/remotes/origin/HEAD"),
      "refs/remotes/origin/main",
    );
    assert.equal(await gitOut(clone, "rev-parse", "origin/main"), originTip);
    assert.equal(
      await gitOut(clone, "rev-parse", "--abbrev-ref", "main@{upstream}"),
      "origin/main",
    );
    assert.equal(await gitOut(clone, "for-each-ref", "refs/shigomori/"), "");
    assert.equal(
      await repoIdentityOf(clone),
      await repoIdentityOf(repo),
      "the clone must read as the same repo",
    );
    assert.equal(sent.worktree.projectId, sent.cloned.id);
    assert.equal(sent.worktree.branch, "rudy");
    assert.equal(
      readFileSync(join(sent.worktree.path, "rudy.txt"), "utf8"),
      "rudy\n",
    );
  } finally {
    await otherEngine.close();
  }
});
