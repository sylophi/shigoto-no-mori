// Host side of the device-sync transfer plumbing: bundles are built by
// the CLI into a host-owned temp file and streamed out as chunked
// invoke responses. The transfer registry is a plain in-memory Map in
// this (host/main) process -- transfers are ephemeral by design, so
// nothing survives a restart and nothing is persisted.
import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncContract } from "@shared/ipc/modules/sync";
import type { Handlers } from "@shared/ipc/types";
import { bundleCreateViaCli, dirtyCaptureViaCli } from "@host/ipc/cliDelegate";
import { findProjectOrThrow } from "@host/lib/projects";

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

export const syncHandlers: Handlers<typeof syncContract> = {
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
};
