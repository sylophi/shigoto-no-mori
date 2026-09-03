// Host side of the device-sync transfer plumbing: bundles are built by
// the CLI into a host-owned temp file and streamed out as chunked
// invoke responses. The transfer registry rides the shared idle
// registry (host/lib/idleRegistry.ts) -- transfers are ephemeral by
// design, so nothing survives a restart and nothing is persisted.
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  SyncCaptureDirtyResultSchema,
  type SyncPullProgress,
  type SyncPullWorktreePayloadSchema,
  SyncRefTipsResultSchema,
  type SyncTeardownSourcePayloadSchema,
  type SyncTeardownSourceResult,
  syncContract,
} from "@shared/ipc/modules/sync";

import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { errorMessageOf } from "@shared/errors";
import { DeleteWorktreeResultSchema } from "@shared/schemas";
import {
  bundleCreateViaCli,
  createViaCli,
  dirtyApplyViaCli,
  dirtyCaptureViaCli,
} from "@host/ipc/cliDelegate";
import { peerSyncApiFor, peerWorktreesApiFor } from "@host/ipc/peerSync";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import { createIdleRegistry } from "@host/lib/idleRegistry";
import { run } from "@host/lib/git/core";
import { listBranches } from "@host/lib/git/branches";
import {
  deleteRef,
  hasCommit,
  localBranchTips,
  updateRef,
} from "@host/lib/git/refs";
import {
  findProjectByIdentityOrThrow,
  findProjectOrThrow,
} from "@host/lib/projects";
import { fetchBundleFromPeer } from "@host/lib/sync/fetchBundle";
import { notifierFor } from "./worktrees";

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
function rememberPull(source: SourceRef, receipt: PullReceipt): void {
  pullReceipts.delete(receiptKey(source));
  pullReceipts.set(receiptKey(source), receipt);
  for (const key of pullReceipts.keys()) {
    if (pullReceipts.size <= RECEIPT_LIMIT) break;
    pullReceipts.delete(key);
  }
}

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

export const syncHandlers: Handlers<typeof syncContract, HandlerContext> = {
  refTips: async ({ projectId, refs }) => {
    const project = findProjectOrThrow(projectId);
    const tips: { ref: string; commit: string }[] = [];
    for (const ref of refs) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of cheap probes
      const commit = await run(project.path, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        ref,
      ]).catch(() => null);
      if (commit !== null) tips.push({ ref, commit: commit.trim() });
    }
    return { tips };
  },

  captureDirty: async ({ projectId, worktreeId }) => {
    const project = findProjectOrThrow(projectId);
    return dirtyCaptureViaCli(project, worktreeId);
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

  // The source teardown (v2 step 9), after a pull landed here. The
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
    const result = await tearDownSource(source, receipt);
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
  const dirtyRef = `refs/shigomori/dirty/${source.sourceWorktreeId}`;
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

async function treeOf(projectPath: string, commit: string): Promise<string> {
  const out = await run(projectPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${commit}^{tree}`,
  ]);
  return out.trim();
}

// The source teardown. It runs ONLY when nothing can be lost: an unapplied
// capture means the uncommitted work still exists solely on the
// source, so the source is kept and the caller learns why via
// sourceError. Teardown failures never throw either -- by then the
// pull succeeded and the worktree simply exists on both sides. An
// external (adopted) source worktree keeps its local branch after
// teardown because sm rm skips branch deletion for externals
// (cli/gitx.go deleteBranchAfterWorktreeRemoval), so the branch then
// exists on both devices, which is not lossy.
async function tearDownSource(
  source: SourceRef,
  pulled: { captured: boolean; dirtyApplied: boolean },
): Promise<SyncTeardownSourceResult> {
  if (pulled.captured && !pulled.dirtyApplied) {
    return {
      sourceRemoved: false,
      sourceError:
        "the uncommitted changes could not be applied here and only exist on the source worktree",
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
      await peerWorktreesApiFor(source.sourceDeviceId).delete({
        projectId: source.sourceProjectId,
        worktreeId: source.sourceWorktreeId,
        force: pulled.captured,
        refuseRunningScripts: true,
      }),
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

// The pull orchestration (v2 step 7, slice C), shared with the
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
async function runPullWorktree(
  {
    sourceDeviceId,
    sourceProjectId,
    sourceWorktreeId,
    sourceIdentity,
    branch,
  }: z.infer<typeof SyncPullWorktreePayloadSchema>,
  ctx: HandlerContext,
) {
  // Running commentary back to the caller, keyed by the source id (the
  // only id it holds until the create lands). Frames are droppable
  // presence, never state: the result is the single source of truth.
  const notifyProgress = ctx.notifier(syncContract, "pullProgress");
  const progress = (frame: Omit<SyncPullProgress, "sourceWorktreeId">) =>
    notifyProgress({ sourceWorktreeId, ...frame });

  // 1. The local target repo, re-resolved by identity from disk.
  const project = await findProjectByIdentityOrThrow(sourceIdentity);

  // 2. Updating an existing branch is out of scope. Refuse up front
  // with the state the user can act on.
  const { local } = await listBranches(project.path);
  if (local.includes(branch)) {
    throw new Error(
      `${branch} already exists on this device. Delete that branch (or its worktree) first, or open it and pull normally.`,
    );
  }

  const peer = peerSyncApiFor(sourceDeviceId);
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
  const sourceDirtyRef = `refs/shigomori/dirty/${sourceWorktreeId}`;
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

    // 5. The ordinary create, on a new branch at the incoming ref.
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
      { branchName: branch, base: incomingRef },
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

    // 6. Capture refs are keyed by worktree id, and ids are derived
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
    let dirtyApplied = false;
    if (capture.captured && capture.commit !== undefined) {
      progress({ step: "apply" });
      const localDirtyRef = `refs/shigomori/dirty/${worktree.id}`;
      await updateRef(project.path, localDirtyRef, capture.commit);
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
    rememberPull(
      { sourceDeviceId, sourceProjectId, sourceWorktreeId },
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
    return { worktree, captured: capture.captured, dirtyApplied };
  } finally {
    // Sweep the landing ref success or fail. A survivor is not
    // harmless: a stale incoming/foo blocks any later incoming/foo/bar
    // at git's directory/file ref boundary.
    await deleteRef(project.path, incomingRef).catch(() => {});
  }
}
