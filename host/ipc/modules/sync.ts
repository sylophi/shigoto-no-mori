// Host side of the device-sync transfer plumbing: bundles are built by
// the CLI into a host-owned temp file and streamed out as chunked
// invoke responses. The transfer registry rides the shared idle
// registry (host/lib/idleRegistry.ts) -- transfers are ephemeral by
// design, so nothing survives a restart and nothing is persisted.
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  SyncCaptureDirtyResultSchema,
  type SyncCloneInto,
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
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
import {
  DeleteWorktreeResultSchema,
  isRealBranch,
  type Project,
  type Worktree,
} from "@shared/schemas";
import {
  type TransferFilesResult,
  transferFilesOnce,
} from "@host/mirror/oneShot";
import {
  bundleCreateViaCli,
  bundleUnpackViaCli,
  createViaCli,
  dirtyApplyViaCli,
  dirtyCaptureViaCli,
} from "@host/ipc/cliDelegate";
import {
  peerProjectsApiFor,
  peerSyncApiFor,
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
} from "@host/ipc/peerSync";
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
import { listWorktreeIdentities } from "@host/lib/git/worktrees";
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
  findProjectByIdentity,
  findProjectByIdentityOrThrow,
  findProjectOrThrow,
  NO_PROJECT_OF_IDENTITY,
} from "@host/lib/projects";
import { cloneProjectFromPeer } from "@host/lib/sync/cloneFromPeer";
import { fetchBundleFromPeer } from "@host/lib/sync/fetchBundle";
import { pushBundleToPeer } from "@host/lib/sync/pushBundle";
import { notifierFor, worktreesHandlers } from "./worktrees";

// The ref the CLI's dirty capture lands a worktree's uncommitted state
// under (cli/cmd_dirty.go owns the name on that side).
const dirtyRefFor = (worktreeId: string) =>
  `refs/shigomori/dirty/${worktreeId}`;

type SourceRef = z.infer<typeof SyncTeardownSourcePayloadSchema>;

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
type SentRef = z.infer<typeof SyncTeardownSentPayloadSchema>;
type SendReceipt = Omit<PullReceipt, "targetProjectId">;
const sendReceipts = new Map<string, SendReceipt>();
const sentKey = (sent: SentRef) =>
  `${sent.targetDeviceId}/${sent.projectId}/${sent.worktreeId}`;

// A registered transfer: the bundle file (inside its own mkdtemp dir,
// 0700, so the data is no more readable than the repo it came from).
type Transfer = { dir: string; path: string; bytes: number };

// The idle sweep is the entire lifecycle bookkeeping (see the
// idleRegistry header): a receiver that vanished mid-transfer (crash,
// network) leaks at most one temp file for the idle window.
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

export const syncHandlers: Handlers<typeof syncContract, HandlerContext> = {
  pushStart: async ({ projectId, bytes }) => {
    findProjectOrThrow(projectId);
    const dir = await mkdtemp(join(tmpdir(), "sm-sync-recv-"));
    const path = join(dir, "push.bundle");
    const handle = await open(path, "w");
    const transferId = pushes.mint({
      projectId,
      dir,
      path,
      handle,
      bytes,
      received: 0,
      writes: new Set(),
      failed: false,
    });
    return { transferId, pipelined: true };
  },

  // Chunks arrive in offset order (one socket, dispatched as they
  // land), so an offset that is not the next byte is a broken sender,
  // not a retry to honor. The sender may have several in flight, so
  // the bytes are claimed BEFORE the write is awaited: the next chunk's
  // check runs while this one is still writing. A write that fails
  // fails its chunk, and the sender gives the transfer up.
  pushChunk: async ({ transferId, offset, dataB64 }) => {
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
  },

  pushFinish: async ({ transferId, refspecs }) => {
    const push = pushes.get(transferId);
    if (push === undefined) throw new Error("unknown-transfer");
    try {
      // A well-behaved sender finishes only once every chunk was
      // answered. One that does not must still not unpack under a
      // write.
      await Promise.allSettled(push.writes);
      if (push.failed) throw new Error("push failed: a chunk was not written");
      if (push.received !== push.bytes) {
        throw new Error(
          `push incomplete: got ${push.received} of ${push.bytes} bytes`,
        );
      }
      await push.handle.close();
      const project = findProjectOrThrow(push.projectId);
      // The CLI re-validates every dst under refs/shigomori/ before any
      // git spawn (cli/cmd_bundle.go), the same wall the pull's unpack
      // stands behind.
      return await bundleUnpackViaCli(project, push.path, refspecs);
    } finally {
      await pushes.drop(transferId);
    }
  },

  hasCommits: async ({ projectId, commits }) => {
    const project = findProjectOrThrow(projectId);
    const present: string[] = [];
    for (const commit of commits) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of cheap probes
      if (await hasCommit(project.path, commit)) present.push(commit);
    }
    return { present };
  },

  refTips: async ({ projectId, refs }) => {
    const project = findProjectOrThrow(projectId);
    const tips: { ref: string; commit: string }[] = [];
    for (const ref of refs) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of cheap probes
      const commit = await refTip(project.path, ref);
      if (commit !== null) tips.push({ ref, commit });
    }
    return { tips };
  },

  captureDirty: async ({ projectId, worktreeId }) => {
    const project = findProjectOrThrow(projectId);
    return dirtyCaptureViaCli(project, worktreeId);
  },

  worktreeFolder: async ({ projectId, worktreeId, relative }) => {
    const { worktree } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return listWorktreeFolder(worktree.path, relative);
  },

  // The ignored files a capture leaves behind (see the contract note):
  // listed against the worktree, not the project, so a peer's
  // transplant dialog can name what a teardown would take with it.
  ignoredPaths: async ({ projectId, worktreeId }) => {
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
  },

  bundleStart: async ({ projectId, refs, haves }) => {
    const project = findProjectOrThrow(projectId);
    // refs/haves passed the contract's fail-closed allowlist schemas
    // already; the CLI re-validates with its own complementary shape
    // (see the gate note in shared/ipc/modules/sync.ts) before argv.
    const dir = await mkdtemp(join(tmpdir(), "sm-sync-"));
    try {
      const path = join(dir, "transfer.bundle");
      const created = await bundleCreateViaCli(project, path, refs, haves);
      // Only the transfer handle and the byte count travel back. The
      // CLI also reports the refs it resolved, but that list is
      // computed against the repo AFTER `git bundle create` silently
      // dropped any have-covered ref, so it can name refs the bundle
      // lacks -- and no consumer reads it.
      const transferId = transfers.mint({ dir, path, bytes: created.bytes });
      return { transferId, bytes: created.bytes };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  },

  bundleChunk: async ({ transferId, offset }) => {
    const transfer = transfers.get(transferId);
    // Stable marker, not prose, matching the wire's hyphenated marker
    // family (unknown-conn, conn-closed): the id resolves to no live
    // transfer, which after a valid start means it was dropped
    // (eof-finished or idle-swept), NOT a malformed request. Asserted
    // by the sync check; no client branches on it yet.
    if (transfer === undefined) throw new Error("unknown-transfer");
    transfers.touch(transferId);
    // Clamp: the schema pinned offset to a nonnegative int, so the only
    // remaining bad shape is past-the-end, which reads zero bytes.
    const remaining = Math.max(
      0,
      transfer.bytes - Math.min(offset, transfer.bytes),
    );
    const length = Math.min(WIRE_CHUNK_BYTES, remaining);
    let data = Buffer.alloc(0);
    if (length > 0) {
      const handle = await open(transfer.path, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        data = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    }
    const eof = offset + data.length >= transfer.bytes;
    if (eof) await transfers.drop(transferId);
    return { dataB64: data.toString("base64"), eof };
  },

  // Idempotent and non-throwing: aborting an unknown or already-finished
  // transfer is a no-op, and the drop callback swallows rm failures, so
  // a receiver's best-effort cleanup resolves regardless of the outcome.
  bundleAbort: async ({ transferId }) => {
    await transfers.drop(transferId);
  },

  pullWorktree: runPullWorktree,

  // The receiving half of a send (runSendWorktree below drives both
  // from the sending device). The identity is re-resolved from disk
  // here, the same wall the pull stands behind, so a send structurally
  // cannot land in a repo that is not the sender's.
  landCheck: async ({ identity, branch, worktreeName, landBranch }) => {
    const project = await findProjectByIdentityOrThrow(identity);
    const landing = landBranch ?? branch;
    await refuseLandingCollision(project, landing, worktreeName);
    return { projectId: project.id };
  },

  // The push left the branch under the incoming ref, unless this
  // device already held its tip, in which case nothing crossed and the
  // ref is set here. Either way the tip and the capture must be
  // commits this repo holds, checked before the create so a transfer
  // that fell short never leaves a worktree without its changes. The
  // sweep covers a refused create too, for the pull's reason: a stale
  // incoming ref blocks later ones beneath its name.
  landWorktree: async (
    {
      identity,
      branch,
      worktreeName,
      landBranch,
      branchTip,
      runSetup,
      capture,
    },
    ctx,
  ) => {
    const project = await findProjectByIdentityOrThrow(identity);
    const incomingRef = `refs/shigomori/incoming/${branch}`;
    const landing = landBranch ?? branch;
    try {
      await refuseLandingCollision(project, landing, worktreeName);
      const expected = [branchTip, ...(capture ? [capture.commit] : [])];
      for (const commit of expected) {
        // oxlint-disable-next-line no-await-in-loop -- two cheap probes at most
        if (!(await hasCommit(project.path, commit))) {
          throw new Error(`${branch} did not arrive whole on this device.`);
        }
      }
      await updateRef(project.path, incomingRef, branchTip);
      return await landIncoming(
        project,
        { branch: landing, incomingRef, worktreeName, runSetup, capture },
        ctx,
      );
    } finally {
      await deleteRef(project.path, incomingRef).catch(() => {});
    }
  },

  sendWorktree: async (input, ctx) => (await sendWorktree(input, ctx)).result,

  // The sent worktree's teardown, the mirror image of teardownSource
  // below: the send's own receipt decides whether it may run, the
  // local source must still be exactly what was sent, and a refusal is
  // an answer, not a throw.
  teardownSent: async (sent, ctx) => {
    const key = sentKey(sent);
    const receipt = sendReceipts.get(key);
    if (receipt === undefined) {
      throw new Error(
        "No send recorded for that worktree on this device. Send it first.",
      );
    }
    const changed = await sentSourceChangedSince(sent, receipt);
    if (changed !== undefined) {
      return { sourceRemoved: false, sourceError: changed };
    }
    const result = await tearDown(receipt, "on the other device", (force) =>
      worktreesHandlers.delete(
        {
          projectId: sent.projectId,
          worktreeId: sent.worktreeId,
          force,
          refuseRunningScripts: true,
        },
        ctx,
      ),
    );
    if (result.sourceRemoved) sendReceipts.delete(key);
    return result;
  },

  // The source teardown, after a pull landed here. The
  // pull's own receipt decides whether it may run at all. Without one
  // (no pull, or a restart in between) the call refuses outright
  // rather than guess. The receipt is kept until a teardown actually
  // removes the source, so a refused or failed one can be retried.
  teardownSource: async (source) => {
    const key = receiptKey(source);
    const receipt = pullReceipts.get(key);
    if (receipt === undefined) {
      throw new Error(
        "No pull recorded for that worktree on this device. Bring it here first.",
      );
    }
    const changed = await sourceChangedSince(source, receipt);
    if (changed !== undefined) {
      return { sourceRemoved: false, sourceError: changed };
    }
    const result = await tearDown(receipt, "here", (force) =>
      peerWorktreesApiFor(source.sourceDeviceId).delete({
        projectId: source.sourceProjectId,
        worktreeId: source.sourceWorktreeId,
        force,
        refuseRunningScripts: true,
      }),
    );
    if (result.sourceRemoved) pullReceipts.delete(key);
    return result;
  },
};

// The teardown may run any time after the pull, so the source is
// re-checked against the receipt first: the branch tip must not have
// moved, and the uncommitted state must still be exactly the tree the
// pull captured (a fresh capture on the peer, fetched thin against the
// tip and compared by tree hash, since capture commits are not
// deterministic). Anything else is work that never crossed, and the
// reason comes back as the kept-source explanation.
async function sourceChangedSince(
  source: SourceRef,
  receipt: PullReceipt,
): Promise<string | undefined> {
  const peer = peerSyncApiFor(source.sourceDeviceId);
  const branchRef = `refs/heads/${receipt.branch}`;
  const { tips } = SyncRefTipsResultSchema.parse(
    await peer.refTips({
      projectId: source.sourceProjectId,
      refs: [branchRef],
    }),
  );
  if (tips.find((tip) => tip.ref === branchRef)?.commit !== receipt.branchTip) {
    return "the branch on the source device moved after it was brought here.";
  }
  const fresh = SyncCaptureDirtyResultSchema.parse(
    await peer.captureDirty({
      projectId: source.sourceProjectId,
      worktreeId: source.sourceWorktreeId,
    }),
  );
  const changedSince =
    "the source worktree changed after its uncommitted work was captured.";
  if (!fresh.captured) return receipt.captured ? changedSince : undefined;
  if (!receipt.captured || receipt.captureTree === undefined) {
    return "the source worktree has uncommitted changes that were never brought here.";
  }
  const project = findProjectOrThrow(receipt.targetProjectId);
  const dirtyRef = dirtyRefFor(source.sourceWorktreeId);
  try {
    await fetchBundleFromPeer(peer, {
      sourceProjectId: source.sourceProjectId,
      targetProjectId: project.id,
      refs: [dirtyRef],
      haves: [receipt.branchTip],
    });
    const tree = await treeOf(project.path, fresh.commit ?? "");
    return tree === receipt.captureTree ? undefined : changedSince;
  } finally {
    await deleteRef(project.path, dirtyRef).catch(() => {});
  }
}

// The same proof for a sent worktree, all of it local: the branch has
// not moved since the send, and a fresh capture holds the tree the
// send captured.
async function sentSourceChangedSince(
  sent: SentRef,
  receipt: SendReceipt,
): Promise<string | undefined> {
  const project = findProjectOrThrow(sent.projectId);
  const tip = await refTip(project.path, `refs/heads/${receipt.branch}`);
  if (tip !== receipt.branchTip) {
    return "the branch moved after it was sent.";
  }
  const fresh = await dirtyCaptureViaCli(project, sent.worktreeId);
  const changedSince =
    "the worktree changed after its uncommitted work was captured.";
  if (!fresh.captured) return receipt.captured ? changedSince : undefined;
  if (
    !receipt.captured ||
    receipt.captureTree === undefined ||
    fresh.commit === undefined
  ) {
    return "the worktree has uncommitted changes that were never sent.";
  }
  const tree = await treeOf(project.path, fresh.commit);
  return tree === receipt.captureTree ? undefined : changedSince;
}

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
async function tearDown(
  pulled: { captured: boolean; dirtyApplied: boolean },
  landed: "here" | "on the other device",
  remove: (force: boolean) => unknown,
): Promise<SyncTeardownSourceResult> {
  if (pulled.captured && !pulled.dirtyApplied) {
    return {
      sourceRemoved: false,
      sourceError: `the uncommitted changes could not be applied ${landed} and only exist on the source worktree`,
    };
  }
  try {
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
    const removed = DeleteWorktreeResultSchema.parse(
      await remove(pulled.captured),
    );
    if (removed.ok) return { sourceRemoved: true };
    // ok:false means the worktree was NOT removed: cleanup scripts
    // run before `git worktree remove` and a failure aborts the
    // pipeline with the worktree left in place (cli/cmd_rm.go).
    return {
      sourceRemoved: false,
      sourceError: `cleanup failed on the source device (${removed.cleanupError.phase})`,
    };
  } catch (error) {
    return { sourceRemoved: false, sourceError: errorMessageOf(error) };
  }
}

// Where a landing would refuse, shared by the pull and by the
// receiving half of a send. Updating an existing branch is out of
// scope, so a held one refuses with the state the user can act on.
async function refuseLandingCollision(
  project: Project,
  branch: string,
  worktreeName: string | undefined,
): Promise<void> {
  const [{ local }, existing] = await Promise.all([
    listBranches(project.path),
    listWorktreeIdentities(project.id, project.path),
  ]);
  if (local.includes(branch)) {
    // Name the worktree holding it when one does: that is the thing
    // the user has to stop or delete.
    const holder = existing.find((w) => w.branch === branch);
    throw new Error(pullBranchCollision(branch, holder?.path));
  }
  // Git keeps refs in a directory tree, so a branch can sit neither
  // under an existing one nor above it: mirror/main is refused by a
  // branch named mirror, and a branch named mirror by mirror/main.
  // Refused here, before the transfer, rather than by the create.
  const inTheWay = local.find(
    (name) => name.startsWith(`${branch}/`) || branch.startsWith(`${name}/`),
  );
  if (inTheWay !== undefined) {
    throw new Error(
      `${branch} cannot be created here: a branch named ${inTheWay} is in the way (git allows one of the two). Rename that branch first.`,
    );
  }
  // The copy keeps the source's folder name, and the CLI create
  // refuses a taken one (cli/worktree.go: a worktree of this project
  // by that name, case-insensitively, or anything at the path). That
  // refusal lands at the create, after the bundle crossed. The same
  // two checks here refuse before a byte moves.
  if (worktreeName !== undefined) {
    const wanted = worktreeName.toLowerCase();
    const config = await readShigomoriConfig(project.id).catch(() => null);
    const target = worktreePathForProject(project.path, config, worktreeName);
    if (
      existing.some((w) => w.name.toLowerCase() === wanted) ||
      (await pathExists(target))
    ) {
      throw new Error(pullFolderCollision(worktreeName, target));
    }
  }
}

// The pull's landing project: the checkout this device has of the
// repo, or the one the pull makes when it has none and was told where
// (cloneFromPeer.ts). A checkout it has wins over a place named for a
// new one: the dialog that named it was reading a stale list, and a
// second clone of a repo already here is not what anyone asked for.
async function landingProject(
  identity: string,
  cloneInto: SyncCloneInto | undefined,
  clone: (into: SyncCloneInto) => Promise<Project>,
): Promise<{ project: Project; cloned: boolean }> {
  const held = await findProjectByIdentity(identity);
  if (held !== undefined) return { project: held, cloned: false };
  if (cloneInto === undefined) throw new Error(NO_PROJECT_OF_IDENTITY);
  return { project: await clone(cloneInto), cloned: true };
}

// The landing proper, shared the same way: the worktree created on the
// incoming ref, then the capture re-applied in it. The caller owns the
// incoming ref and its sweep. `branch` is the one the copy is created
// on, which the incoming ref need not be named after.
async function landIncoming(
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
): Promise<{ worktree: Worktree; dirtyApplied: boolean }> {
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
  const { worktree } = await createViaCli(
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
  );

  // Capture refs are keyed by worktree id, and ids are derived
  // from paths (sha256(path)[:12]), so the source's id names the
  // worktree just created only when both devices minted the SAME
  // managed path (root/worktrees/<project>/<name> with the name from
  // a shared pool) -- rare, but real across same-username machines.
  // Re-key the ref to the local id, then apply and let the CLI
  // consume it. On that collision the re-key is a no-op and the
  // delete below is skipped, or it would discard the capture it just
  // parked. An apply refusal (a setup script left an untracked file,
  // say) does NOT throw away the successful create: the worktree is
  // real, the capture stays parked under the local id for sm dirty
  // apply, and the caller learns via dirtyApplied:false.
  // The frame is emitted either way, so the last step reads as
  // reached on a clean source too (and a mirror's session open,
  // which follows, is not mistaken for a stuck create).
  progress({ step: "apply" });
  let dirtyApplied = false;
  if (input.capture !== undefined) {
    const sourceDirtyRef = dirtyRefFor(input.capture.sourceWorktreeId);
    const localDirtyRef = dirtyRefFor(worktree.id);
    await updateRef(project.path, localDirtyRef, input.capture.commit);
    if (localDirtyRef !== sourceDirtyRef) {
      await deleteRef(project.path, sourceDirtyRef);
    }
    try {
      await dirtyApplyViaCli(project, worktree.id);
      dirtyApplied = true;
    } catch (error) {
      console.warn("[sync] dirty apply failed after create:", error);
    }
  }
  return { worktree, dirtyApplied };
}

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
export async function runPullWorktree(
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
    cloneInto,
  }: z.infer<typeof SyncPullWorktreePayloadSchema>,
  ctx: HandlerContext,
  // The branch the copy is created on when it is not the source's (the
  // mirror start's, for a primary: shared/git/branches.ts). Not on the
  // wire: what lands is decided by what the source is, on the host.
  { landBranch }: { landBranch?: string } = {},
) {
  const landing = landBranch ?? branch;
  // Running commentary back to the caller, keyed by the source id (the
  // only id it holds until the create lands). Frames are droppable
  // presence, never state: the result is the single source of truth.
  const notifyProgress = ctx.notifier(syncContract, "pullProgress");
  const progress = (frame: Omit<SyncPullProgress, "sourceWorktreeId">) =>
    notifyProgress({ sourceWorktreeId, ...frame });

  // 1. The local target repo, re-resolved by identity from disk, or
  // made now: with none, and a place named for one, the repo is
  // cloned from the peer first and the copy lands in that.
  const peer = peerSyncApiFor(sourceDeviceId);
  const { project, cloned } = await landingProject(
    sourceIdentity,
    cloneInto,
    (into) => {
      progress({ step: "clone" });
      return cloneProjectFromPeer(
        { sync: peer, projects: peerProjectsApiFor(sourceDeviceId) },
        sourceProjectId,
        into,
        (bytes, totalBytes) => progress({ step: "clone", bytes, totalBytes }),
      );
    },
  );

  // 2. Refuse up front what the create would refuse after the bundle
  // crossed.
  await refuseLandingCollision(project, landing, worktreeName);

  const branchRef = `refs/heads/${branch}`;

  // 3. Tip negotiation, then capture. The tip decides whether the
  // branch needs transferring at all: `git bundle create` silently
  // drops a ref covered by a have, so requesting a branch whose tip
  // we already hold would corrupt the transfer, not thin it.
  // Both answers are re-parsed here because their hashes flow into
  // LOCAL git argv: the peer's own dev-build output validation is not
  // this device's wall.
  const { tips } = SyncRefTipsResultSchema.parse(
    await peer.refTips({
      projectId: sourceProjectId,
      refs: [branchRef],
    }),
  );
  const branchTip = tips.find((tip) => tip.ref === branchRef)?.commit;
  if (branchTip === undefined) {
    throw new Error(`${branch} no longer exists on the source device.`);
  }
  progress({ step: "capture" });
  const capture = SyncCaptureDirtyResultSchema.parse(
    await peer.captureDirty({
      projectId: sourceProjectId,
      worktreeId: sourceWorktreeId,
    }),
  );

  // 4. Fetch what's missing. Tip already here + clean worktree means
  // nothing crosses at all.
  const tipIsLocal = await hasCommit(project.path, branchTip);
  const sourceDirtyRef = dirtyRefFor(sourceWorktreeId);
  const wantRefs = [
    ...(tipIsLocal ? [] : [branchRef]),
    ...(capture.captured ? [sourceDirtyRef] : []),
  ];
  const incomingRef = `refs/shigomori/incoming/${branch}`;
  try {
    if (wantRefs.length > 0) {
      // The fetch opens the transfer step itself with its (0, total)
      // frame, so only the nothing-to-fetch case needs a bare tick.
      await fetchBundleFromPeer(peer, {
        sourceProjectId,
        targetProjectId: project.id,
        refs: wantRefs,
        onProgress: (bytes, totalBytes) =>
          progress({ step: "transfer", bytes, totalBytes }),
        // With the tip local the only novel commit is the capture, so
        // the tip itself is the perfect (and safe) have. Otherwise every
        // local branch tip thins the bundle, and none can cover the
        // branch tip: covering it would mean we already hold it. The
        // exception is a shallow clone, where a have can cover a tip
        // hasCommit said we lack, and that surfaces as a loud bundle error
        // before anything is mutated, never as silent corruption.
        haves: tipIsLocal ? [branchTip] : await localBranchTips(project.path),
      });
    } else {
      progress({ step: "transfer" });
    }
    if (tipIsLocal) await updateRef(project.path, incomingRef, branchTip);

    // 5 and 6. The create on the incoming ref, then the capture
    // re-applied in it.
    const { worktree, dirtyApplied } = await landIncoming(
      project,
      {
        branch: landing,
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
      const source = await peerWorktreeOrUndefined(
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
          : await transferFilesOnce(
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
    remember(
      pullReceipts,
      receiptKey({ sourceDeviceId, sourceProjectId, sourceWorktreeId }),
      {
        targetProjectId: project.id,
        branch,
        branchTip,
        captured: capture.captured,
        dirtyApplied,
        captureTree:
          capture.captured && capture.commit !== undefined
            ? await treeOf(project.path, capture.commit)
            : undefined,
      },
    );
    return {
      worktree,
      captured: capture.captured,
      dirtyApplied,
      files,
      ...(cloned ? { cloned: project } : {}),
    };
  } finally {
    // Sweep the landing ref success or fail. A survivor is not
    // harmless: a stale incoming/foo blocks any later incoming/foo/bar
    // at git's directory/file ref boundary.
    await deleteRef(project.path, incomingRef).catch(() => {});
  }
}

// A landing refusal is worded on the peer, where "this device" means
// the peer, so it is attributed before it reaches this device's user.
// The command refusal passes as it is: surfaces match on its text.
function fromPeer<T>(answer: Promise<T>): Promise<T> {
  return answer.catch((error: unknown) => {
    if (isCommandRefusedError(error)) throw error;
    throw new Error(`The other device answered: ${errorMessageOf(error)}`);
  });
}

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
export async function sendWorktree(
  {
    targetDeviceId,
    projectId,
    worktreeId,
    runSetup,
    ignoreMode,
    ignores,
  }: z.infer<typeof SyncSendWorktreePayloadSchema>,
  ctx: HandlerContext,
  // The mirror start's send: the one that may take a primary checkout
  // (it lands on the peer as mirror/<branch>, and the session then
  // keeps the pair in step). A plain send moves a worktree, and the
  // primary is the project itself.
  { mirror = false }: { mirror?: boolean } = {},
) {
  const notifyProgress = ctx.notifier(syncContract, "pullProgress");
  const progress = (frame: Omit<SyncPullProgress, "sourceWorktreeId">) =>
    notifyProgress({ sourceWorktreeId: worktreeId, ...frame });

  // 1. The local source. A detached head has no branch to land.
  const { project, worktree } = await findProjectAndWorktreeOrThrow(
    projectId,
    worktreeId,
  );
  if (worktree.detached || !isRealBranch(worktree.branch)) {
    throw new Error("Only a worktree on a branch of its own can be sent.");
  }
  if (worktree.isPrimary && !mirror) {
    throw new Error(
      "The primary checkout can be mirrored but not sent: it is the project itself.",
    );
  }
  const identity = await getRepoIdentity(project.path).catch(() => null);
  if (identity === null) {
    throw new Error(
      "This repository has no shared identity, so no other device can be matched to it.",
    );
  }
  const branch = worktree.branch;
  const worktreeName = pullWorktreeName(worktree);
  const landing = pullLandingBranch(worktree);
  const target = {
    identity,
    branch,
    worktreeName,
    ...(landing === branch ? {} : { landBranch: landing }),
  };

  // 2. The peer's refusals, before a byte moves. Its answers are
  // re-parsed like the pull's: they flow into the push below.
  const peer = peerSyncApiFor(targetDeviceId);
  const { projectId: peerProjectId } = SyncLandCheckResultSchema.parse(
    await fromPeer(peer.landCheck(target)),
  );

  // 3. The tip, then the capture, with the peer asked meanwhile which
  // of this repo's tips it holds: the branch's own, and the other
  // local branches' for thinning. One round trip answers both.
  const branchRef = `refs/heads/${branch}`;
  const branchTip = await refTip(project.path, branchRef);
  if (branchTip === null) throw new Error(`${branch} no longer exists.`);
  const otherTips = (await localBranchTips(project.path))
    .filter((tip) => tip !== branchTip)
    .slice(0, SYNC_HAS_COMMITS_LIMIT - 1);
  progress({ step: "capture" });
  const [capture, held] = await Promise.all([
    dirtyCaptureViaCli(project, worktreeId),
    peer.hasCommits({
      projectId: peerProjectId,
      commits: [branchTip, ...otherTips],
    }),
  ]);
  const captured = capture.captured && capture.commit !== undefined;
  const { present } = SyncHasCommitsResultSchema.parse(held);

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
    await pushBundleToPeer(peer, {
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

  // 5. The landing, on the peer.
  progress({ step: "create" });
  const landed = SyncLandWorktreeResultSchema.parse(
    await fromPeer(
      peer.landWorktree({
        ...target,
        branchTip,
        runSetup,
        capture:
          captured && capture.commit !== undefined
            ? { sourceWorktreeId: worktreeId, commit: capture.commit }
            : undefined,
      }),
    ),
  );
  progress({ step: "apply" });

  // 6. The ignored files, pushed into the root the peer's landing
  // answered with (re-parsed above, like everything it sends).
  let files: TransferFilesResult | undefined;
  if (pullBringsIgnoredFiles(ignoreMode)) {
    progress({ step: "files" });
    files = await transferFilesOnce(
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
  remember(sendReceipts, sentKey({ targetDeviceId, projectId, worktreeId }), {
    branch,
    branchTip,
    captured,
    dirtyApplied: landed.dirtyApplied,
    captureTree:
      captured && capture.commit !== undefined
        ? await treeOf(project.path, capture.commit)
        : undefined,
  });
  return {
    source: worktree,
    result: {
      worktree: landed.worktree,
      captured,
      dirtyApplied: landed.dirtyApplied,
      files,
    },
  };
}
