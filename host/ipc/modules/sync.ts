// Host side of the device-sync transfer plumbing: bundles are built by
// the CLI into a host-owned temp file and streamed out as chunked
// invoke responses. The transfer registry rides the shared idle
// registry (host/lib/idleRegistry.ts) -- transfers are ephemeral by
// design, so nothing survives a restart and nothing is persisted.
//
// Every handler is an Effect run under its caller's signal
// (hostHandler), so a caller that leaves (a closed window, a dropped
// peer socket, a killed CLI) interrupts the work at its next step. The
// steps that must not be left half done are marked uninterruptible
// where they sit: a bundle landing in refs/shigomori/, a worktree
// being created on an incoming ref. A temp file a single call makes is
// a resource of that call's fiber (host/lib/sync/scopedFiles.ts),
// removed the moment the call ends however it ended. A transfer that
// outlives the call that started it (a bundle served chunk by chunk,
// a push written chunk by chunk) is handed to its registry, whose idle
// sweep is the backstop.
import type { FileHandle } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  SyncCaptureDirtyResultSchema,
  SyncHasCommitsResultSchema,
  SyncLandCheckResultSchema,
  SyncLandWorktreeResultSchema,
  type SyncPullProgress,
  type SyncPullWorktreePayloadSchema,
  SyncRefTipsResultSchema,
  type SyncSendWorktreePayloadSchema,
  SYNC_HAS_COMMITS_LIMIT,
  SYNC_IGNORED_PATHS_LIMIT,
  type SyncTeardownSentPayloadSchema,
  type SyncTeardownSourcePayloadSchema,
  type SyncTeardownSourceResult,
  syncContract,
  pullBringsIgnoredFiles,
} from "@shared/ipc/modules/sync";

import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { errorMessageOf } from "@shared/errors";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import { pullWorktreeName } from "@shared/git/branches";
import {
  DeleteWorktreeResultSchema,
  isRealBranch,
  type Project,
  type Worktree,
} from "@shared/schemas";
import { type TransferFilesResult, transferFiles } from "@host/mirror/oneShot";
import {
  bundleCreateViaCli,
  bundleUnpackViaCli,
  createViaCli,
  dirtyApplyViaCli,
  dirtyCaptureViaCli,
} from "@host/ipc/cliDelegate";
import { peerApis, peerWorktree } from "@host/ipc/peerSync";
import {
  isCommandRefusedError,
  WIRE_CHUNK_BYTES,
} from "@shared/ipc/socket/frames";
import { createIdleRegistry } from "@host/lib/idleRegistry";
import { listBranches } from "@host/lib/git/branches";
import { readShigomoriConfig } from "@host/lib/config/project";
import { pathExists } from "@host/lib/util/paths";
import { worktreePathForProject } from "@host/lib/worktrees/paths";
import { listIgnoreRules } from "@host/lib/git/ignoreRules";
import {
  cachedIgnoredPaths,
  listWorktreeFolder,
} from "@host/lib/worktrees/carryOver";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import {
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import {
  deleteRef,
  hasCommit,
  localBranchTips,
  refTip,
  treeOf,
  updateRef,
} from "@host/lib/git/refs";
import {
  findProjectAndWorktreeOrThrow,
  findProjectByIdentityOrThrow,
  findProjectOrThrow,
} from "@host/lib/projects";
import { fetchBundle } from "@host/lib/sync/fetchBundle";
import { pushBundle } from "@host/lib/sync/pushBundle";
import { scopedFile, scopedTempDir } from "@host/lib/sync/scopedFiles";
import { hostAttempt, hostHandler } from "@host/runtime";
import { notifierFor, worktreesHandlers } from "./worktrees";

// The ref the CLI's dirty capture lands a worktree's uncommitted state
// under (cli/cmd_dirty.go owns the name on that side).
const dirtyRefFor = (worktreeId: string) =>
  `refs/shigomori/dirty/${worktreeId}`;

type SourceRef = typeof SyncTeardownSourcePayloadSchema.Type;

// What each pull captured and applied, by source worktree, for the
// teardown that may follow. Written by the pull itself and read by the
// teardown, so the data-loss rule runs on the host's own facts: a
// caller cannot claim a capture landed when it did not. The branch tip
// and the capture's tree let the teardown prove the source is still
// exactly what was brought here, however long the user took to decide.
// Ephemeral by design (a restart forgets, and the teardown then
// refuses), bounded so a host that pulls for weeks never grows it.
type PullReceipt = {
  targetProjectId: string;
  branch: string;
  branchTip: string;
  captured: boolean;
  dirtyApplied: boolean;
  captureTree?: string;
};
const RECEIPT_LIMIT = 64;
const pullReceipts = new Map<string, PullReceipt>();
const receiptKey = (source: SourceRef) =>
  `${source.sourceDeviceId}/${source.sourceProjectId}/${source.sourceWorktreeId}`;
function remember<Receipt>(
  receipts: Map<string, Receipt>,
  key: string,
  receipt: Receipt,
): void {
  receipts.delete(key);
  receipts.set(key, receipt);
  for (const oldest of receipts.keys()) {
    if (receipts.size <= RECEIPT_LIMIT) break;
    receipts.delete(oldest);
  }
}

// The same record for a send, where the source is this device's own
// worktree and the peer is where it went. The tip and the capture's
// tree are this repo's, so the teardown's proof never leaves the
// machine.
type SentRef = typeof SyncTeardownSentPayloadSchema.Type;
type SendReceipt = Omit<PullReceipt, "targetProjectId">;
const sendReceipts = new Map<string, SendReceipt>();
const sentKey = (sent: SentRef) =>
  `${sent.targetDeviceId}/${sent.projectId}/${sent.worktreeId}`;

// A registered transfer: the bundle file (inside its own mkdtemp dir,
// 0700, so the data is no more readable than the repo it came from).
type Transfer = { dir: string; path: string; bytes: number };

// A transfer outlives the call that started it (the chunks are later
// calls), so it is not a resource of any one fiber: the eof, the
// receiver's abort (sent the moment its own caller leaves, see
// fetchBundle) and the idle sweep (see the idleRegistry header) are its
// lifecycle. A receiver that vanished mid-transfer (crash, network)
// leaks at most one temp file for the idle window.
//
// Two accepted caveats, both by design, neither worth machinery here:
//   - A hard crash of THIS process skips the sweep entirely, so its
//     os.tmpdir()/sm-sync-* dirs orphan until the OS reclaims tmp. The
//     sweep only covers a receiver that gave up while we kept running.
//   - A granted peer can hold several repo-sized temp bundles at once
//     while actively chunking them. That is grant-gated (a trusted
//     peer), so there is deliberately no size or count quota.
const TRANSFER_IDLE_MS = 10 * 60_000;

const transfers = createIdleRegistry<Transfer>({
  idleMs: TRANSFER_IDLE_MS,
  // Best-effort cleanup: rm({force:true}) swallows ENOENT but still
  // throws on EPERM/EBUSY, and a drop can run void'd from the sweep
  // timer, so swallow the rejection -- the worst case is a temp dir
  // the OS reclaims later.
  onDrop: (transfer) =>
    rm(transfer.dir, { recursive: true, force: true }).catch(() => {}),
});

// An incoming push (the peer's git follower shipping commits here):
// the bundle is written into its own temp dir as chunks arrive, then
// unpacked by the CLI on finish. Same idle sweep as the outbound
// transfers, so a sender that vanished mid-push leaks one temp file
// for the idle window.
type IncomingPush = {
  projectId: string;
  dir: string;
  path: string;
  handle: FileHandle;
  bytes: number;
  // Bytes claimed by the chunks accepted so far, written or not yet.
  received: number;
  // The chunk writes still in flight.
  writes: Set<Promise<unknown>>;
  // A chunk write rejected, so the file has a hole `received` hides.
  failed: boolean;
};

const pushes = createIdleRegistry<IncomingPush>({
  idleMs: TRANSFER_IDLE_MS,
  onDrop: async (push) => {
    await push.handle.close().catch(() => {});
    await rm(push.dir, { recursive: true, force: true }).catch(() => {});
  },
});

// A chunk of an incoming push. Chunks arrive in offset order (one
// socket, dispatched as they land), so an offset that is not the next
// byte is a broken sender, not a retry to honor. The sender may have
// several in flight, so the bytes are claimed BEFORE the write is
// awaited: the next chunk's check runs while this one is still
// writing. A write that fails fails its chunk, and the sender gives
// the transfer up.
async function writePushChunk({
  transferId,
  offset,
  dataB64,
}: {
  transferId: string;
  offset: number;
  dataB64: string;
}): Promise<void> {
  const push = pushes.get(transferId);
  if (push === undefined) throw new Error("unknown-transfer");
  pushes.touch(transferId);
  const data = Buffer.from(dataB64, "base64");
  if (offset !== push.received) throw new Error("push chunk out of order");
  if (push.received + data.length > push.bytes) {
    throw new Error("push overran the announced size");
  }
  push.received += data.length;
  const write = push.handle.write(data, 0, data.length, offset);
  push.writes.add(write);
  try {
    await write;
  } catch (error) {
    // The bytes were claimed and are not on disk, so the count no
    // longer proves the file whole: the finish must refuse.
    push.failed = true;
    throw error;
  } finally {
    push.writes.delete(write);
  }
}

const dropTransfer = (transferId: string) =>
  Effect.promise(() => transfers.drop(transferId));

// Sweeps a landing ref, success or fail. A survivor is not harmless: a
// stale incoming/foo blocks any later incoming/foo/bar at git's
// directory/file ref boundary.
const sweepRef = (repo: string, ref: string) =>
  Effect.promise(() => deleteRef(repo, ref).catch(() => {}));

// The ignored files a capture leaves behind (see the contract note):
// listed against the worktree, not the project, so a peer's
// transplant dialog can name what a teardown would take with it. The
// control ops ask it too.
export const ignoredPathsOf = ({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}) =>
  hostAttempt(async () => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    const [paths, patterns] = await Promise.all([
      cachedIgnoredPaths(worktree.path),
      listIgnoreRules(worktree.path),
    ]);
    return {
      paths: paths.slice(0, SYNC_IGNORED_PATHS_LIMIT),
      total: paths.length,
      patterns,
    };
  });

export const syncHandlers: Handlers<typeof syncContract, HandlerContext> = {
  // The push's file and handle belong to this call until the registry
  // holds them, so a sender that leaves before the mint leaves nothing
  // behind. From the mint on they are the registry's: the chunks and
  // the finish are later calls.
  pushStart: hostHandler(({ projectId, bytes }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* hostAttempt(() => findProjectOrThrow(projectId));
        const dir = yield* scopedTempDir("sm-sync-recv-");
        const path = join(dir.value, "push.bundle");
        const handle = yield* scopedFile(path, "w");
        const transferId = pushes.mint({
          projectId,
          dir: dir.value,
          path,
          handle: handle.value,
          bytes,
          received: 0,
          writes: new Set(),
          failed: false,
        });
        dir.handOff();
        handle.handOff();
        return { transferId, pipelined: true };
      }),
    ),
  ),

  // One step: a sender that leaves stops waiting for the write, never
  // the write itself, which stays tracked on the push for the finish.
  pushChunk: hostHandler((input) =>
    hostAttempt(() => writePushChunk(input)).pipe(Effect.as(undefined)),
  ),

  pushFinish: hostHandler(({ transferId, refspecs }) =>
    Effect.gen(function* () {
      const push = pushes.get(transferId);
      if (push === undefined) {
        return yield* Effect.fail(new Error("unknown-transfer"));
      }
      return yield* Effect.gen(function* () {
        // A well-behaved sender finishes only once every chunk was
        // answered. One that does not must still not unpack under a
        // write.
        yield* hostAttempt(() => Promise.allSettled(push.writes));
        if (push.failed) {
          return yield* Effect.fail(
            new Error("push failed: a chunk was not written"),
          );
        }
        if (push.received !== push.bytes) {
          return yield* Effect.fail(
            new Error(
              `push incomplete: got ${push.received} of ${push.bytes} bytes`,
            ),
          );
        }
        // Uninterruptible: the unpack is one non-atomic git fetch into
        // refs/shigomori/ that runs to its end whatever this fiber
        // does, so the drop below (which removes the bundle) waits for
        // it rather than pulling the file out from under it. The CLI
        // re-validates every dst under refs/shigomori/ before any git
        // spawn (cli/cmd_bundle.go), the same wall the pull's unpack
        // stands behind.
        return yield* Effect.uninterruptible(
          hostAttempt(async () => {
            await push.handle.close();
            const project = findProjectOrThrow(push.projectId);
            return bundleUnpackViaCli(project, push.path, refspecs);
          }),
        );
      }).pipe(Effect.ensuring(Effect.promise(() => pushes.drop(transferId))));
    }),
  ),

  hasCommits: hostHandler(({ projectId, commits }) =>
    Effect.gen(function* () {
      const project = yield* hostAttempt(() => findProjectOrThrow(projectId));
      const present: string[] = [];
      for (const commit of commits) {
        if (yield* hostAttempt(() => hasCommit(project.path, commit))) {
          present.push(commit);
        }
      }
      return { present };
    }),
  ),

  refTips: hostHandler(({ projectId, refs }) =>
    Effect.gen(function* () {
      const project = yield* hostAttempt(() => findProjectOrThrow(projectId));
      const tips: { ref: string; commit: string }[] = [];
      for (const ref of refs) {
        const commit = yield* hostAttempt(() => refTip(project.path, ref));
        if (commit !== null) tips.push({ ref, commit });
      }
      return { tips };
    }),
  ),

  captureDirty: hostHandler(({ projectId, worktreeId }) =>
    hostAttempt(() =>
      dirtyCaptureViaCli(findProjectOrThrow(projectId), worktreeId),
    ),
  ),

  worktreeFolder: hostHandler(({ projectId, worktreeId, relative }) =>
    hostAttempt(async () => {
      const { worktree } = await findProjectAndWorktreeOrThrow(
        projectId,
        worktreeId,
      );
      return listWorktreeFolder(worktree.path, relative);
    }),
  ),

  ignoredPaths: hostHandler(ignoredPathsOf),

  // The bundle is built into a dir this call owns until the registry
  // holds it: a receiver that leaves mid-build (a large repo takes a
  // while) takes the dir with it at once, and the CLI's create then
  // fails on the removed dir, its answer unread.
  bundleStart: hostHandler(({ projectId, refs, haves }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* hostAttempt(() => findProjectOrThrow(projectId));
        // refs/haves passed the contract's fail-closed allowlist schemas
        // already; the CLI re-validates with its own complementary shape
        // (see the gate note in shared/ipc/modules/sync.ts) before argv.
        const dir = yield* scopedTempDir("sm-sync-");
        const path = join(dir.value, "transfer.bundle");
        const created = yield* hostAttempt(() =>
          bundleCreateViaCli(project, path, refs, haves),
        );
        // Only the transfer handle and the byte count travel back. The
        // CLI also reports the refs it resolved, but that list is
        // computed against the repo AFTER `git bundle create` silently
        // dropped any have-covered ref, so it can name refs the bundle
        // lacks -- and no consumer reads it.
        const transferId = transfers.mint({
          dir: dir.value,
          path,
          bytes: created.bytes,
        });
        dir.handOff();
        return { transferId, bytes: created.bytes };
      }),
    ),
  ),

  bundleChunk: hostHandler(({ transferId, offset }) =>
    Effect.gen(function* () {
      const transfer = transfers.get(transferId);
      // Stable marker, not prose, matching the wire's hyphenated marker
      // family (unknown-conn, conn-closed): the id resolves to no live
      // transfer, which after a valid start means it was dropped
      // (eof-finished or idle-swept), NOT a malformed request. Asserted
      // by the sync check; no client branches on it yet.
      if (transfer === undefined) {
        return yield* Effect.fail(new Error("unknown-transfer"));
      }
      transfers.touch(transferId);
      // Clamp: the schema pinned offset to a nonnegative int, so the
      // only remaining bad shape is past-the-end, which reads zero bytes.
      const remaining = Math.max(
        0,
        transfer.bytes - Math.min(offset, transfer.bytes),
      );
      const length = Math.min(WIRE_CHUNK_BYTES, remaining);
      const data =
        length > 0
          ? yield* Effect.scoped(
              Effect.flatMap(scopedFile(transfer.path, "r"), (handle) =>
                hostAttempt(async () => {
                  const buffer = Buffer.alloc(length);
                  const { bytesRead } = await handle.value.read(
                    buffer,
                    0,
                    length,
                    offset,
                  );
                  return buffer.subarray(0, bytesRead);
                }),
              ),
            )
          : Buffer.alloc(0);
      const eof = offset + data.length >= transfer.bytes;
      if (eof) yield* dropTransfer(transferId);
      return { dataB64: data.toString("base64"), eof };
    }),
  ),

  // Idempotent and non-throwing: aborting an unknown or already-finished
  // transfer is a no-op, and the drop callback swallows rm failures, so
  // a receiver's best-effort cleanup resolves regardless of the outcome.
  bundleAbort: hostHandler(({ transferId }) =>
    dropTransfer(transferId).pipe(Effect.as(undefined)),
  ),

  pullWorktree: hostHandler((input, ctx: HandlerContext) =>
    runPullWorktree(input, ctx),
  ),

  // The receiving half of a send (sendWorktree below drives both
  // from the sending device). The identity is re-resolved from disk
  // here, the same wall the pull stands behind, so a send structurally
  // cannot land in a repo that is not the sender's.
  landCheck: hostHandler(({ identity, branch, worktreeName }) =>
    Effect.gen(function* () {
      const project = yield* hostAttempt(() =>
        findProjectByIdentityOrThrow(identity),
      );
      yield* refuseLandingCollision(project, branch, worktreeName);
      return { projectId: project.id };
    }),
  ),

  // The push left the branch under the incoming ref, unless this
  // device already held its tip, in which case nothing crossed and the
  // ref is set here. Either way the tip and the capture must be
  // commits this repo holds, checked before the create so a transfer
  // that fell short never leaves a worktree without its changes. The
  // sweep covers a refused create too, for the pull's reason: a stale
  // incoming ref blocks later ones beneath its name.
  landWorktree: hostHandler(
    (
      { identity, branch, worktreeName, branchTip, runSetup, capture },
      ctx: HandlerContext,
    ) =>
      Effect.gen(function* () {
        const project = yield* hostAttempt(() =>
          findProjectByIdentityOrThrow(identity),
        );
        const incomingRef = `refs/shigomori/incoming/${branch}`;
        return yield* Effect.gen(function* () {
          yield* refuseLandingCollision(project, branch, worktreeName);
          const expected = [branchTip, ...(capture ? [capture.commit] : [])];
          for (const commit of expected) {
            if (!(yield* hostAttempt(() => hasCommit(project.path, commit)))) {
              return yield* Effect.fail(
                new Error(`${branch} did not arrive whole on this device.`),
              );
            }
          }
          yield* hostAttempt(() =>
            updateRef(project.path, incomingRef, branchTip),
          );
          return yield* landIncoming(
            project,
            { branch, incomingRef, worktreeName, runSetup, capture },
            ctx,
          );
        }).pipe(Effect.ensuring(sweepRef(project.path, incomingRef)));
      }),
  ),

  sendWorktree: hostHandler((input, ctx: HandlerContext) =>
    Effect.map(sendWorktree(input, ctx), (sent) => sent.result),
  ),

  teardownSent: hostHandler((sent, ctx: HandlerContext) =>
    teardownSent(sent, ctx),
  ),

  teardownSource: hostHandler((source) => teardownSource(source)),
};

// The sent worktree's teardown, the mirror image of teardownSource
// below: the send's own receipt decides whether it may run, the
// local source must still be exactly what was sent, and a refusal is
// an answer, not a throw.
export const teardownSent = (sent: SentRef, ctx: HandlerContext) =>
  Effect.gen(function* () {
    const key = sentKey(sent);
    const receipt = sendReceipts.get(key);
    if (receipt === undefined) {
      return yield* Effect.fail(
        new Error(
          "No send recorded for that worktree on this device. Send it first.",
        ),
      );
    }
    const changed = yield* sentSourceChangedSince(sent, receipt);
    if (changed !== undefined) {
      return { sourceRemoved: false, sourceError: changed };
    }
    const result = yield* tearDown(receipt, "on the other device", (force) =>
      hostAttempt(() =>
        worktreesHandlers.delete(
          {
            projectId: sent.projectId,
            worktreeId: sent.worktreeId,
            force,
            refuseRunningScripts: true,
          },
          ctx,
        ),
      ),
    );
    if (result.sourceRemoved) sendReceipts.delete(key);
    return result;
  });

// The source teardown, after a pull landed here. The
// pull's own receipt decides whether it may run at all. Without one
// (no pull, or a restart in between) the call refuses outright
// rather than guess. The receipt is kept until a teardown actually
// removes the source, so a refused or failed one can be retried.
export const teardownSource = (source: SourceRef) =>
  Effect.gen(function* () {
    const key = receiptKey(source);
    const receipt = pullReceipts.get(key);
    if (receipt === undefined) {
      return yield* Effect.fail(
        new Error(
          "No pull recorded for that worktree on this device. Bring it here first.",
        ),
      );
    }
    const changed = yield* sourceChangedSince(source, receipt);
    if (changed !== undefined) {
      return { sourceRemoved: false, sourceError: changed };
    }
    const apis = yield* peerApis;
    const result = yield* tearDown(receipt, "here", (force) =>
      hostAttempt(() =>
        apis.worktreesApiFor(source.sourceDeviceId).delete({
          projectId: source.sourceProjectId,
          worktreeId: source.sourceWorktreeId,
          force,
          refuseRunningScripts: true,
        }),
      ),
    );
    if (result.sourceRemoved) pullReceipts.delete(key);
    return result;
  });

// The teardown may run any time after the pull, so the source is
// re-checked against the receipt first: the branch tip must not have
// moved, and the uncommitted state must still be exactly the tree the
// pull captured (a fresh capture on the peer, fetched thin against the
// tip and compared by tree hash, since capture commits are not
// deterministic). Anything else is work that never crossed, and the
// reason comes back as the kept-source explanation.
const sourceChangedSince = (source: SourceRef, receipt: PullReceipt) =>
  Effect.gen(function* () {
    const peer = (yield* peerApis).syncApiFor(source.sourceDeviceId);
    const branchRef = `refs/heads/${receipt.branch}`;
    const { tips } = yield* hostAttempt(async () =>
      Schema.decodeUnknownSync(SyncRefTipsResultSchema)(
        await peer.refTips({
          projectId: source.sourceProjectId,
          refs: [branchRef],
        }),
      ),
    );
    if (
      tips.find((tip) => tip.ref === branchRef)?.commit !== receipt.branchTip
    ) {
      return "the branch on the source device moved after it was brought here.";
    }
    const fresh = yield* hostAttempt(async () =>
      Schema.decodeUnknownSync(SyncCaptureDirtyResultSchema)(
        await peer.captureDirty({
          projectId: source.sourceProjectId,
          worktreeId: source.sourceWorktreeId,
        }),
      ),
    );
    const changedSince =
      "the source worktree changed after its uncommitted work was captured.";
    if (!fresh.captured) return receipt.captured ? changedSince : undefined;
    if (!receipt.captured || receipt.captureTree === undefined) {
      return "the source worktree has uncommitted changes that were never brought here.";
    }
    const project = yield* hostAttempt(() =>
      findProjectOrThrow(receipt.targetProjectId),
    );
    const dirtyRef = dirtyRefFor(source.sourceWorktreeId);
    return yield* Effect.gen(function* () {
      yield* fetchBundle(peer, {
        sourceProjectId: source.sourceProjectId,
        targetProjectId: project.id,
        refs: [dirtyRef],
        haves: [receipt.branchTip],
      });
      const tree = yield* hostAttempt(() =>
        treeOf(project.path, fresh.commit ?? ""),
      );
      return tree === receipt.captureTree ? undefined : changedSince;
    }).pipe(Effect.ensuring(sweepRef(project.path, dirtyRef)));
  });

// The same proof for a sent worktree, all of it local: the branch has
// not moved since the send, and a fresh capture holds the tree the
// send captured.
const sentSourceChangedSince = (sent: SentRef, receipt: SendReceipt) =>
  Effect.gen(function* () {
    const project = yield* hostAttempt(() =>
      findProjectOrThrow(sent.projectId),
    );
    const tip = yield* hostAttempt(() =>
      refTip(project.path, `refs/heads/${receipt.branch}`),
    );
    if (tip !== receipt.branchTip) {
      return "the branch moved after it was sent.";
    }
    const fresh = yield* hostAttempt(() =>
      dirtyCaptureViaCli(project, sent.worktreeId),
    );
    const changedSince =
      "the worktree changed after its uncommitted work was captured.";
    if (!fresh.captured) return receipt.captured ? changedSince : undefined;
    const commit = fresh.commit;
    if (
      !receipt.captured ||
      receipt.captureTree === undefined ||
      commit === undefined
    ) {
      return "the worktree has uncommitted changes that were never sent.";
    }
    const tree = yield* hostAttempt(() => treeOf(project.path, commit));
    return tree === receipt.captureTree ? undefined : changedSince;
  });

// The source teardown. It runs ONLY when nothing the capture describes
// can be lost: an unapplied capture means the uncommitted work still
// exists solely on the source, so the source is kept and the caller
// learns why via sourceError. Ignored files are outside what a capture
// describes and die with the source either way, forced or not: git's
// own pre-removal check refuses untracked and modified files, never
// ignored ones. Deliberately not a refusal here (the ignoredPaths note
// in the contract says why). The dialog lists them before the choice.
// Teardown failures never throw either -- by then the pull succeeded
// and the worktree simply exists on both sides. An
// external (adopted) source worktree keeps its local branch after
// teardown because sm rm skips branch deletion for externals
// (cli/gitx.go deleteBranchAfterWorktreeRemoval), so the branch then
// exists on both devices, which is not lossy.
// Both directions run it: a pull tears down the peer's worktree over
// the wire, a send this device's own through the same handler, and
// `landed` is where the copy went, for the refusal's wording.
const tearDown = (
  pulled: { captured: boolean; dirtyApplied: boolean },
  landed: "here" | "on the other device",
  remove: (force: boolean) => Effect.Effect<unknown, unknown>,
): Effect.Effect<SyncTeardownSourceResult> => {
  if (pulled.captured && !pulled.dirtyApplied) {
    return Effect.succeed({
      sourceRemoved: false,
      sourceError: `the uncommitted changes could not be applied ${landed} and only exist on the source worktree`,
    });
  }
  // Force only when the dirty state was actually captured and
  // applied here. The CLI's --force does more than skip its own
  // clean-tree guard (cmd_rm.go requireClean): it also switches to
  // `git worktree remove --force` and enables the ENOTEMPTY
  // force-wipe fallback, which would silently destroy work a
  // capture cannot carry (submodule-only dirt captures as clean,
  // see the cli/cmd_dirty.go header) or edits made after the
  // capture. So on a capture that said clean, git's own pre-removal
  // check must independently agree before the source dies, and a
  // disagreement surfaces as sourceRemoved:false with the git
  // message instead of silent loss. Accepted cost: worktrees with
  // populated submodules report sourceRemoved:false on clean
  // transplants because git refuses non-forced removal of them.
  // refuseRunningScripts is the app-side guard the local
  // kill-then-delete path deliberately lacks.
  return remove(pulled.captured).pipe(
    Effect.flatMap((answer) =>
      hostAttempt(() =>
        Schema.decodeUnknownSync(DeleteWorktreeResultSchema)(answer),
      ),
    ),
    Effect.map(
      (removed): SyncTeardownSourceResult =>
        removed.ok
          ? { sourceRemoved: true }
          : // ok:false means the worktree was NOT removed: cleanup
            // scripts run before `git worktree remove` and a failure
            // aborts the pipeline with the worktree left in place
            // (cli/cmd_rm.go).
            {
              sourceRemoved: false,
              sourceError: `cleanup failed on the source device (${removed.cleanupError.phase})`,
            },
    ),
    Effect.catch((error) =>
      Effect.succeed({
        sourceRemoved: false,
        sourceError: errorMessageOf(error),
      }),
    ),
  );
};

// Where a landing would refuse, shared by the pull and by the
// receiving half of a send. Updating an existing branch is out of
// scope, so a held one refuses with the state the user can act on.
const refuseLandingCollision = (
  project: Project,
  branch: string,
  worktreeName: string | undefined,
) =>
  Effect.gen(function* () {
    const [{ local }, existing] = yield* Effect.all(
      [
        hostAttempt(() => listBranches(project.path)),
        hostAttempt(() => listWorktreeIdentities(project.id, project.path)),
      ],
      { concurrency: "unbounded" },
    );
    if (local.includes(branch)) {
      // Name the worktree holding it when one does: that is the thing
      // the user has to stop or delete.
      const holder = existing.find((w) => w.branch === branch);
      return yield* Effect.fail(
        new Error(pullBranchCollision(branch, holder?.path)),
      );
    }
    // The copy keeps the source's folder name, and the CLI create
    // refuses a taken one (cli/worktree.go: a worktree of this project
    // by that name, case-insensitively, or anything at the path). That
    // refusal lands at the create, after the bundle crossed. The same
    // two checks here refuse before a byte moves.
    if (worktreeName !== undefined) {
      const wanted = worktreeName.toLowerCase();
      const config = yield* hostAttempt(() =>
        readShigomoriConfig(project.id),
      ).pipe(Effect.orElseSucceed(() => null));
      const target = worktreePathForProject(project.path, config, worktreeName);
      if (
        existing.some((w) => w.name.toLowerCase() === wanted) ||
        (yield* hostAttempt(() => pathExists(target)))
      ) {
        return yield* Effect.fail(
          new Error(pullFolderCollision(worktreeName, target)),
        );
      }
    }
  });

// The landing proper, shared the same way: the worktree created on the
// incoming ref, then the capture re-applied in it. The caller owns the
// incoming ref and its sweep.
//
// Uninterruptible as a whole: once the create starts, a worktree is
// being added on the incoming ref, and the caller's sweep of that ref
// must wait for it, as must the capture that belongs in it. A caller
// that leaves here gets a finished landing (the worktree with its
// changes applied, or parked for sm dirty apply), never a worktree
// without its changes or a create whose base ref vanished under it.
const landIncoming = (
  project: Project,
  input: {
    branch: string;
    incomingRef: string;
    worktreeName: string | undefined;
    runSetup: boolean | undefined;
    // The capture commit, and the worktree id its ref arrived under.
    capture: { sourceWorktreeId: string; commit: string } | undefined;
  },
  ctx: HandlerContext,
  progress: (
    frame: Pick<SyncPullProgress, "step" | "createPhase">,
  ) => void = () => {},
): Effect.Effect<{ worktree: Worktree; dirtyApplied: boolean }, unknown> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      // The ordinary create, on a new branch at the incoming ref.
      // checkout stays UNSET: checkout:true would leave the worktree ON
      // the incoming ref instead of the new branch. resolveOn "exit"
      // holds the mutation until carry-over and setup finished, so the
      // dirty apply below never races the setup scripts. The new
      // worktree's own lifecycle phases still reach its detail page as
      // usual. They are mirrored into the pull's progress because the
      // caller cannot subscribe by an id that does not exist yet.
      progress({ step: "create" });
      const notify = notifierFor(ctx);
      const { worktree } = yield* hostAttempt(() =>
        createViaCli(
          project,
          {
            branchName: input.branch,
            base: input.incomingRef,
            worktreeName: input.worktreeName,
            skipSetup: input.runSetup === false,
          },
          {
            ...notify,
            notifyPhase: (payload) => {
              notify.notifyPhase(payload);
              if (payload.phase !== "idle") {
                progress({ step: "create", createPhase: payload.phase });
              }
            },
          },
          { resolveOn: "exit" },
        ),
      );

      // Capture refs are keyed by worktree id, and ids are derived
      // from paths (sha256(path)[:12]), so the source's id names the
      // worktree just created only when both devices minted the SAME
      // managed path (root/worktrees/<project>/<name> with the name
      // from a shared pool) -- rare, but real across same-username
      // machines. Re-key the ref to the local id, then apply and let
      // the CLI consume it. On that collision the re-key is a no-op and
      // the delete below is skipped, or it would discard the capture it
      // just parked. An apply refusal (a setup script left an untracked
      // file, say) does NOT throw away the successful create: the
      // worktree is real, the capture stays parked under the local id
      // for sm dirty apply, and the caller learns via
      // dirtyApplied:false. The frame is emitted either way, so the
      // last step reads as reached on a clean source too (and a
      // mirror's session open, which follows, is not mistaken for a
      // stuck create).
      progress({ step: "apply" });
      const capture = input.capture;
      if (capture === undefined) return { worktree, dirtyApplied: false };
      const sourceDirtyRef = dirtyRefFor(capture.sourceWorktreeId);
      const localDirtyRef = dirtyRefFor(worktree.id);
      yield* hostAttempt(() =>
        updateRef(project.path, localDirtyRef, capture.commit),
      );
      if (localDirtyRef !== sourceDirtyRef) {
        yield* hostAttempt(() => deleteRef(project.path, sourceDirtyRef));
      }
      const dirtyApplied = yield* hostAttempt(() =>
        dirtyApplyViaCli(project, worktree.id),
      ).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.warn("[sync] dirty apply failed after create:", error);
            return false;
          }),
        ),
      );
      return { worktree, dirtyApplied };
    }),
  );

// What a caller may hear from inside the landing step, for the one
// that must act on a landing its caller did not wait for.
export type PullHooks = {
  onLanded?: (worktree: Worktree) => void;
};
export type SendHooks = {
  // The copy as the peer answered it, and the local source it was
  // made from.
  onLanded?: (copy: Worktree, source: WorktreeIdentity) => void;
};

// The pull orchestration, shared with the
// transplant orchestrator above: bring a peer device's worktree here.
// Local-only by contract (remote:false). The peer's half is the
// grant-gated transfer surface above, driven through the injected peer
// api. Sequenced: verify local target -> capture the peer's dirty
// state -> land branch + capture under refs/shigomori/ -> create the
// worktree through the ordinary CLI create (carry-over and setup ride
// along) -> re-key and apply the capture -> sweep the incoming ref.
// The incoming ref is swept in a finally that opens BEFORE the fetch:
// the CLI's bundle unpack runs one non-atomic git fetch over several
// refspecs, so a partial fetch can land the incoming ref and then
// throw, and a survivor is NOT harmless -- a stale
// refs/shigomori/incoming/foo blocks any later ref named
// incoming/foo/bar at git's directory/file boundary. A failure before
// the create leaves at most the capture ref (a retry overwrites it).
// After the create, an apply failure resolves with dirtyApplied:false
// rather than throwing: the worktree and branch are real and useful,
// and the dirty state is still safe on the source device.
//
// Interruptible everywhere but the landing (see landIncoming) and the
// unpack inside the fetch (see fetchBundle): a caller that leaves
// mid-transfer stops it at the next chunk, its temp bundle goes at
// once and the peer is told, and the incoming ref is swept on the way
// out. The files step ends its engine session the same way.
export const runPullWorktree = (
  {
    sourceDeviceId,
    sourceProjectId,
    sourceWorktreeId,
    sourceIdentity,
    branch,
    worktreeName,
    runSetup,
    ignoreMode,
    ignores,
  }: typeof SyncPullWorktreePayloadSchema.Type,
  ctx: HandlerContext,
  hooks: PullHooks = {},
) =>
  Effect.gen(function* () {
    // Running commentary back to the caller, keyed by the source id
    // (the only id it holds until the create lands). Frames are
    // droppable presence, never state: the result is the single source
    // of truth.
    const notifyProgress = ctx.notifier(syncContract, "pullProgress");
    const progress = (frame: Omit<SyncPullProgress, "sourceWorktreeId">) =>
      notifyProgress({ sourceWorktreeId, ...frame });

    // 1. The local target repo, re-resolved by identity from disk.
    const project = yield* hostAttempt(() =>
      findProjectByIdentityOrThrow(sourceIdentity),
    );

    // 2. Refuse up front what the create would refuse after the bundle
    // crossed.
    yield* refuseLandingCollision(project, branch, worktreeName);

    const peer = (yield* peerApis).syncApiFor(sourceDeviceId);
    const branchRef = `refs/heads/${branch}`;

    // 3. Tip negotiation, then capture. The tip decides whether the
    // branch needs transferring at all: `git bundle create` silently
    // drops a ref covered by a have, so requesting a branch whose tip
    // we already hold would corrupt the transfer, not thin it.
    // Both answers are re-parsed here because their hashes flow into
    // LOCAL git argv: the peer's own dev-build output validation is not
    // this device's wall.
    const { tips } = yield* hostAttempt(async () =>
      Schema.decodeUnknownSync(SyncRefTipsResultSchema)(
        await peer.refTips({
          projectId: sourceProjectId,
          refs: [branchRef],
        }),
      ),
    );
    const branchTip = tips.find((tip) => tip.ref === branchRef)?.commit;
    if (branchTip === undefined) {
      return yield* Effect.fail(
        new Error(`${branch} no longer exists on the source device.`),
      );
    }
    progress({ step: "capture" });
    const capture = yield* hostAttempt(async () =>
      Schema.decodeUnknownSync(SyncCaptureDirtyResultSchema)(
        await peer.captureDirty({
          projectId: sourceProjectId,
          worktreeId: sourceWorktreeId,
        }),
      ),
    );

    // 4. Fetch what's missing. Tip already here + clean worktree means
    // nothing crosses at all.
    const tipIsLocal = yield* hostAttempt(() =>
      hasCommit(project.path, branchTip),
    );
    const sourceDirtyRef = dirtyRefFor(sourceWorktreeId);
    const wantRefs = [
      ...(tipIsLocal ? [] : [branchRef]),
      ...(capture.captured ? [sourceDirtyRef] : []),
    ];
    const incomingRef = `refs/shigomori/incoming/${branch}`;
    // The incoming ref is swept however this ends, the sweep opening
    // BEFORE the fetch (see the header above).
    return yield* Effect.gen(function* () {
      if (wantRefs.length > 0) {
        // The fetch opens the transfer step itself with its (0, total)
        // frame, so only the nothing-to-fetch case needs a bare tick.
        // With the tip local the only novel commit is the capture, so
        // the tip itself is the perfect (and safe) have. Otherwise every
        // local branch tip thins the bundle, and none can cover the
        // branch tip: covering it would mean we already hold it. The
        // exception is a shallow clone, where a have can cover a tip
        // hasCommit said we lack, and that surfaces as a loud bundle
        // error before anything is mutated, never as silent corruption.
        const haves = tipIsLocal
          ? [branchTip]
          : yield* hostAttempt(() => localBranchTips(project.path));
        yield* fetchBundle(peer, {
          sourceProjectId,
          targetProjectId: project.id,
          refs: wantRefs,
          onProgress: (bytes, totalBytes) =>
            progress({ step: "transfer", bytes, totalBytes }),
          haves,
        });
      } else {
        progress({ step: "transfer" });
      }
      if (tipIsLocal) {
        yield* hostAttempt(() =>
          updateRef(project.path, incomingRef, branchTip),
        );
      }

      // 5 and 6. The create on the incoming ref, then the capture
      // re-applied in it, then the receipt the teardown reads: one
      // uninterruptible step. With the receipt outside it, a caller
      // leaving during the create would get its worktree with no
      // record of where it came from, and the teardown would refuse.
      // `onLanded` fires inside the step, so a start built on this
      // pull can carry a landing its caller did not wait for to its
      // own end (mirror.ts startMirror).
      const { worktree, dirtyApplied } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const landed = yield* landIncoming(
            project,
            {
              branch,
              incomingRef,
              worktreeName,
              runSetup,
              capture:
                capture.captured && capture.commit !== undefined
                  ? { sourceWorktreeId, commit: capture.commit }
                  : undefined,
            },
            ctx,
            progress,
          );
          const captureCommit = capture.captured ? capture.commit : undefined;
          remember(
            pullReceipts,
            receiptKey({ sourceDeviceId, sourceProjectId, sourceWorktreeId }),
            {
              targetProjectId: project.id,
              branch,
              branchTip,
              captured: capture.captured,
              dirtyApplied: landed.dirtyApplied,
              captureTree:
                captureCommit === undefined
                  ? undefined
                  : yield* hostAttempt(() =>
                      treeOf(project.path, captureCommit),
                    ),
            },
          );
          hooks.onLanded?.(landed.worktree);
          return landed;
        }),
      );

      // 7. The ignored files, once the tree has settled: the leave-out
      // rule admits them and git never carried them, so the mirror
      // engine runs once between the two worktrees (host/mirror/
      // oneShot.ts). Gitignored leaves nothing to carry, and the mirror
      // start passes no rule (its own session, opened next, carries the
      // files and keeps carrying them). Never fatal: the worktree is
      // real, and the outcome rides the result.
      let files: TransferFilesResult | undefined;
      if (pullBringsIgnoredFiles(ignoreMode)) {
        progress({ step: "files" });
        const source = yield* peerWorktree(
          sourceDeviceId,
          sourceProjectId,
          sourceWorktreeId,
        );
        files =
          source === undefined
            ? {
                crossed: false,
                conflicts: 0,
                error: "the source worktree is no longer listed there",
              }
            : yield* transferFiles(
                {
                  localRoot: worktree.path,
                  localWorktreeId: worktree.id,
                  sourceDeviceId,
                  sourceProjectId,
                  sourceWorktreeId,
                  remoteRoot: source.path,
                  name: branch,
                  ignores: ignores ?? [],
                },
                (bytes, totalBytes) =>
                  progress({ step: "files", bytes, totalBytes }),
              );
      }
      return { worktree, captured: capture.captured, dirtyApplied, files };
    }).pipe(Effect.ensuring(sweepRef(project.path, incomingRef)));
  });

// A landing refusal is worded on the peer, where "this device" means
// the peer, so it is attributed before it reaches this device's user.
// The command refusal passes as it is: surfaces match on its text.
const fromPeer = <A>(answer: Effect.Effect<A, unknown>) =>
  Effect.mapError(answer, (error) =>
    isCommandRefusedError(error)
      ? error
      : new Error(`The other device answered: ${errorMessageOf(error)}`),
  );

// The send orchestration, the pull turned around: one of this device's
// worktrees goes to a peer. Local-only by contract (remote:false), and
// every remote step rides the PEER's grant (the push surface, then
// landCheck and landWorktree), so sending needs exactly what a pull
// needs: command access on the other device, none given here.
// Sequenced: the peer's refusals first -> capture the local dirty
// state -> push the branch and the capture, thinned by what the peer
// holds -> the peer lands it (the pull's create and re-apply, run
// there) -> the ignored files, pushed by the mirror engine run once.
// The create's lifecycle phases play out on the peer and are not
// reported back, so the progress goes from the create straight to the
// apply. What the caller names is only the worktree: the branch, the
// folder name and the identity are read off it here. The source it
// resolved rides back beside the result, for the mirror start built on
// this (mirror:startTo), which opens its session on that worktree.
// Interruptible at every step: nothing here lands locally, the push's
// temp bundle is this fiber's, and a landing already asked of the peer
// runs to its end there.
export const sendWorktree = (
  {
    targetDeviceId,
    projectId,
    worktreeId,
    runSetup,
    ignoreMode,
    ignores,
  }: typeof SyncSendWorktreePayloadSchema.Type,
  ctx: HandlerContext,
  hooks: SendHooks = {},
) =>
  Effect.gen(function* () {
    const notifyProgress = ctx.notifier(syncContract, "pullProgress");
    const progress = (frame: Omit<SyncPullProgress, "sourceWorktreeId">) =>
      notifyProgress({ sourceWorktreeId: worktreeId, ...frame });

    // 1. The local source. A primary checkout is the project itself,
    // and a detached head has no branch to land.
    const { project, worktree } = yield* hostAttempt(() =>
      findProjectAndWorktreeOrThrow(projectId, worktreeId),
    );
    if (
      worktree.isPrimary ||
      worktree.detached ||
      !isRealBranch(worktree.branch)
    ) {
      return yield* Effect.fail(
        new Error("Only a worktree on a branch of its own can be sent."),
      );
    }
    const identity = yield* hostAttempt(() =>
      getRepoIdentity(project.path),
    ).pipe(Effect.orElseSucceed(() => null));
    if (identity === null) {
      return yield* Effect.fail(
        new Error(
          "This repository has no shared identity, so no other device can be matched to it.",
        ),
      );
    }
    const branch = worktree.branch;
    const worktreeName = pullWorktreeName(worktree);

    // 2. The peer's refusals, before a byte moves. Its answers are
    // re-parsed like the pull's: they flow into the push below.
    const peer = (yield* peerApis).syncApiFor(targetDeviceId);
    const { projectId: peerProjectId } = yield* fromPeer(
      hostAttempt(() => peer.landCheck({ identity, branch, worktreeName })),
    ).pipe(
      Effect.flatMap((answer) =>
        hostAttempt(() =>
          Schema.decodeUnknownSync(SyncLandCheckResultSchema)(answer),
        ),
      ),
    );

    // 3. The tip, then the capture, with the peer asked meanwhile which
    // of this repo's tips it holds: the branch's own, and the other
    // local branches' for thinning. One round trip answers both.
    const branchRef = `refs/heads/${branch}`;
    const branchTip = yield* hostAttempt(() => refTip(project.path, branchRef));
    if (branchTip === null) {
      return yield* Effect.fail(new Error(`${branch} no longer exists.`));
    }
    const otherTips = (yield* hostAttempt(() => localBranchTips(project.path)))
      .filter((tip) => tip !== branchTip)
      .slice(0, SYNC_HAS_COMMITS_LIMIT - 1);
    progress({ step: "capture" });
    const [capture, held] = yield* Effect.all(
      [
        hostAttempt(() => dirtyCaptureViaCli(project, worktreeId)),
        hostAttempt(() =>
          peer.hasCommits({
            projectId: peerProjectId,
            commits: [branchTip, ...otherTips],
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const captureCommit = capture.captured ? capture.commit : undefined;
    const captured = captureCommit !== undefined;
    const { present } = yield* hostAttempt(() =>
      Schema.decodeUnknownSync(SyncHasCommitsResultSchema)(held),
    );

    // 4. Push what the peer lacks. The pull's tip rule from the other
    // side: a branch whose tip the peer holds must not be named, or
    // `git bundle create` drops it under the have. Otherwise the local
    // branch tips the peer also holds thin the bundle (none of them is
    // the branch's own, which the peer was just found to lack).
    const tipIsThere = present.includes(branchTip);
    const dirtyRef = dirtyRefFor(worktreeId);
    const sendRefs = [
      ...(tipIsThere ? [] : [branchRef]),
      ...(captured ? [dirtyRef] : []),
    ];
    if (sendRefs.length > 0) {
      yield* pushBundle(peer, {
        localProject: project,
        peerProjectId,
        refs: sendRefs,
        haves: tipIsThere ? [branchTip] : present,
        onProgress: (bytes, totalBytes) =>
          progress({ step: "transfer", bytes, totalBytes }),
      });
    } else {
      progress({ step: "transfer" });
    }

    // 5. The landing, on the peer, and the receipt the teardown reads:
    // one uninterruptible step, for the pull's reason. A caller that
    // leaves while the peer creates the copy waits for the answer; the
    // peer finishes the copy either way, and only with the answer can
    // the send be finished (or a start on it rolled back) rather than
    // the copy left behind unknown. `onLanded` fires inside the step
    // (mirror.ts startMirrorTo).
    progress({ step: "create" });
    const landed = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const answered = yield* fromPeer(
          hostAttempt(() =>
            peer.landWorktree({
              identity,
              branch,
              worktreeName,
              branchTip,
              runSetup,
              capture:
                captureCommit === undefined
                  ? undefined
                  : { sourceWorktreeId: worktreeId, commit: captureCommit },
            }),
          ),
        ).pipe(
          Effect.flatMap((answer) =>
            hostAttempt(() =>
              Schema.decodeUnknownSync(SyncLandWorktreeResultSchema)(answer),
            ),
          ),
        );
        remember(
          sendReceipts,
          sentKey({ targetDeviceId, projectId, worktreeId }),
          {
            branch,
            branchTip,
            captured,
            dirtyApplied: answered.dirtyApplied,
            captureTree:
              captureCommit === undefined
                ? undefined
                : yield* hostAttempt(() => treeOf(project.path, captureCommit)),
          },
        );
        hooks.onLanded?.(answered.worktree, worktree);
        return answered;
      }),
    );
    progress({ step: "apply" });

    // 6. The ignored files, pushed into the root the peer's landing
    // answered with (re-parsed above, like everything it sends).
    let files: TransferFilesResult | undefined;
    if (pullBringsIgnoredFiles(ignoreMode)) {
      progress({ step: "files" });
      files = yield* transferFiles(
        {
          localRoot: worktree.path,
          localWorktreeId: worktree.id,
          sourceDeviceId: targetDeviceId,
          sourceProjectId: peerProjectId,
          sourceWorktreeId: landed.worktree.id,
          remoteRoot: landed.worktree.path,
          name: branch,
          ignores: ignores ?? [],
          direction: "push",
        },
        (bytes, totalBytes) => progress({ step: "files", bytes, totalBytes }),
      );
    }
    return {
      source: worktree,
      result: {
        worktree: landed.worktree,
        captured,
        dirtyApplied: landed.dirtyApplied,
        files,
      },
    };
  });
