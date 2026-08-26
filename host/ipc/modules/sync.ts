// Host side of the device-sync transfer plumbing: bundles are built by
// the CLI into a host-owned temp file and streamed out as chunked
// invoke responses. The transfer registry is a plain in-memory Map in
// this (host/main) process -- transfers are ephemeral by design, so
// nothing survives a restart and nothing is persisted.
import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  SyncCaptureDirtyResultSchema,
  type SyncPullWorktreePayloadSchema,
  SyncRefTipsResultSchema,
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

// Raw bytes per chunk. The relay caps the SERIALIZED envelope at
// MAX_RELAY_MESSAGE_BYTES = 1_000_000 (shared/relay/protocol.ts), and
// chunk data rides as base64 inside a JSON res frame inside the relay
// envelope: 640_000 raw bytes -> ceil(640_000/3)*4 = 853_336 base64
// chars, leaving ~146 KB of headroom for the frame and envelope
// fields (tens of bytes in practice) -- comfortably under the cap
// without shaving the margin thin.
export const SYNC_CHUNK_BYTES = 640_000;

// A registered transfer: the bundle file (inside its own mkdtemp dir,
// 0700, so the data is no more readable than the repo it came from)
// and a last-touched stamp for the idle sweep.
type Transfer = { dir: string; path: string; bytes: number; touched: number };

const transfers = new Map<string, Transfer>();

// One idle sweep is the entire lifecycle bookkeeping: a receiver that
// vanished mid-transfer (crash, network) leaks at most one temp file
// for TRANSFER_IDLE_MS. Grant-gated already, so no per-peer quotas.
//
// Two accepted caveats, both by design, neither worth machinery here:
//   - A hard crash of THIS process skips the sweep entirely, so its
//     os.tmpdir()/sm-sync-* dirs orphan until the OS reclaims tmp. The
//     sweep only covers a receiver that gave up while we kept running.
//   - A granted peer can hold several repo-sized temp bundles at once
//     while actively chunking them. That is grant-gated (a trusted
//     peer), so there is deliberately no size or count quota.
const TRANSFER_IDLE_MS = 10 * 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, transfer] of transfers) {
      if (now - transfer.touched > TRANSFER_IDLE_MS) void dropTransfer(id);
    }
    if (transfers.size === 0 && sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, 60_000);
  // Never hold the process open for housekeeping.
  sweepTimer.unref?.();
}

async function dropTransfer(transferId: string): Promise<void> {
  const transfer = transfers.get(transferId);
  if (transfer === undefined) return;
  // Forget the entry first, unconditionally: the Map must shrink even if
  // the unlink loses a race. rm({force:true}) swallows ENOENT but still
  // throws on EPERM/EBUSY, and this runs from a void'd call on the idle
  // sweep timer, where a rejection would be an unhandled rejection that
  // takes down the main process. Best-effort cleanup, so swallow it: the
  // worst case is a temp dir the OS reclaims later.
  transfers.delete(transferId);
  await rm(transfer.dir, { recursive: true, force: true }).catch(() => {});
}

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
      const transferId = randomBytes(16).toString("hex");
      transfers.set(transferId, {
        dir,
        path,
        bytes: created.bytes,
        touched: Date.now(),
      });
      ensureSweep();
      return { transferId, bytes: created.bytes, refs: created.refs };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  },

  bundleChunk: async ({ transferId, offset }) => {
    const transfer = transfers.get(transferId);
    // Stable marker, not prose: the id resolves to no live transfer,
    // which after a valid start means it was dropped (eof-finished or
    // idle-swept), NOT a malformed request. Electron IPC only preserves
    // the message string, so slice C distinguishes "expired, restart the
    // transfer" from a real failure by matching this exact text. Keep it
    // in sync with the checks that assert on /unknown transfer/.
    if (transfer === undefined) throw new Error("unknown transfer");
    transfer.touched = Date.now();
    // Clamp: the schema pinned offset to a nonnegative int, so the only
    // remaining bad shape is past-the-end, which reads zero bytes.
    const remaining = Math.max(
      0,
      transfer.bytes - Math.min(offset, transfer.bytes),
    );
    const length = Math.min(SYNC_CHUNK_BYTES, remaining);
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
    if (eof) await dropTransfer(transferId);
    return { dataB64: data.toString("base64"), eof };
  },

  // Idempotent and non-throwing: aborting an unknown or already-finished
  // transfer is a no-op, and dropTransfer swallows rm failures, so a
  // receiver's best-effort cleanup resolves regardless of the outcome.
  bundleAbort: async ({ transferId }) => {
    await dropTransfer(transferId);
  },

  pullWorktree: runPullWorktree,

  // Transplant (v2 step 9): the pull plus tearing the source worktree
  // down on the peer afterwards. The teardown runs ONLY when nothing
  // can be lost: an unapplied capture means the uncommitted work still
  // exists solely on the source, so the source is kept and the caller
  // learns why via sourceError. Teardown failures never fail the call
  // either -- by then the pull succeeded and the worktree simply exists
  // on both sides. An external (adopted) source worktree keeps its
  // local branch after teardown because sm rm skips branch deletion for
  // externals (cli/gitx.go deleteBranchAfterWorktreeRemoval), so the
  // branch then exists on both devices, which is not lossy.
  transplantWorktree: async (input, ctx) => {
    const pulled = await runPullWorktree(input, ctx);
    if (pulled.captured && !pulled.dirtyApplied) {
      return {
        ...pulled,
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
        await peerWorktreesApiFor(input.sourceDeviceId).delete({
          projectId: input.sourceProjectId,
          worktreeId: input.sourceWorktreeId,
          force: pulled.captured,
          refuseRunningScripts: true,
        }),
      );
      if (removed.ok) return { ...pulled, sourceRemoved: true };
      // ok:false means the worktree was NOT removed: cleanup scripts
      // run before `git worktree remove` and a failure aborts the
      // pipeline with the worktree left in place (cli/cmd_rm.go).
      return {
        ...pulled,
        sourceRemoved: false,
        sourceError: `cleanup failed on the source device (${removed.cleanupError.phase})`,
      };
    } catch (error) {
      return {
        ...pulled,
        sourceRemoved: false,
        sourceError: errorMessageOf(error),
      };
    }
  },
};

// The pull orchestration (v2 step 7, slice C), shared with the
// transplant orchestrator above: bring a peer device's worktree here.
// Local-only by contract (remote:false). The peer's half is the
// grant-gated transfer surface above, driven through the injected peer
// api. Sequenced: verify local target -> capture the peer's dirty
// state -> land branch + capture under refs/shigomori/ -> create the
// worktree through the ordinary CLI create (carry-over and setup ride
// along) -> re-key and apply the capture -> sweep the incoming ref.
// The incoming ref is swept in a finally: a survivor is NOT harmless,
// since a stale refs/shigomori/incoming/foo blocks any later ref named
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
  if (wantRefs.length > 0) {
    await fetchBundleFromPeer(peer, {
      sourceProjectId,
      targetProjectId: project.id,
      refs: wantRefs,
      // With the tip local the only novel commit is the capture, so
      // the tip itself is the perfect (and safe) have. Otherwise every
      // local branch tip thins the bundle, and none can cover the
      // branch tip: covering it would mean we already hold it. The
      // exception is a shallow clone, where a have can cover a tip
      // hasCommit said we lack, and that surfaces as a loud bundle error
      // before anything is mutated, never as silent corruption.
      haves: tipIsLocal ? [branchTip] : await localBranchTips(project.path),
    });
  }
  const incomingRef = `refs/shigomori/incoming/${branch}`;
  if (tipIsLocal) await updateRef(project.path, incomingRef, branchTip);

  try {
    // 5. The ordinary create, on a new branch at the incoming ref.
    // checkout stays UNSET: checkout:true would leave the worktree ON
    // the incoming ref instead of the new branch. resolveOn "exit"
    // holds the mutation until carry-over and setup finished, so the
    // dirty apply below never races the setup scripts.
    const { worktree } = await createViaCli(
      project,
      { branchName: branch, base: incomingRef },
      notifierFor(ctx),
      { resolveOn: "exit" },
    );

    // 6. Capture refs are keyed by worktree id, and ids are derived
    // from paths (sha256(path)[:12]), so the source's id can never
    // name the worktree just created. Re-key the ref to the local id,
    // then apply and let the CLI consume it. An apply refusal (a
    // setup script left an untracked file, say) does NOT throw away
    // the successful create: the worktree is real, the capture stays
    // parked under the local id for sm dirty apply, and the caller
    // learns via dirtyApplied:false.
    let dirtyApplied = false;
    if (capture.captured && capture.commit !== undefined) {
      await updateRef(
        project.path,
        `refs/shigomori/dirty/${worktree.id}`,
        capture.commit,
      );
      await deleteRef(project.path, sourceDirtyRef);
      try {
        await dirtyApplyViaCli(project, worktree.id);
        dirtyApplied = true;
      } catch (error) {
        console.warn("[sync] dirty apply failed after create:", error);
      }
    }
    return { worktree, captured: capture.captured, dirtyApplied };
  } finally {
    // Sweep the landing ref success or fail. A survivor is not
    // harmless: a stale incoming/foo blocks any later incoming/foo/bar
    // at git's directory/file ref boundary.
    await deleteRef(project.path, incomingRef).catch(() => {});
  }
}
