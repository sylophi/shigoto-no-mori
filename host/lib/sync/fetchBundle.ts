// Receiver side of the device-sync transfer plumbing: drives a peer's
// sync:bundleStart / sync:bundleChunk surface into a local temp file,
// then unpacks it into this device's repo via the CLI. Exported for
// the sync orchestration (slice C); no UI here.
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SyncBundleStartResultSchema,
  type syncContract,
} from "@shared/ipc/modules/sync";
import type { Client } from "@shared/ipc/types";
import { bundleUnpackViaCli } from "@host/ipc/cliDelegate";
import { findProjectOrThrow } from "@host/lib/projects";

export interface FetchBundleInput {
  // The project id on the PEER (ids differ per device registry;
  // identity matching across devices is the orchestration's job).
  sourceProjectId: string;
  // The project id in THIS device's registry to unpack into.
  targetProjectId: string;
  // Allowlisted full refs to request (refs/heads/<branch> or
  // refs/shigomori/dirty/<worktreeId>); validated peer-side by the
  // contract schema and again by the CLI.
  refs: string[];
  // Local tips the peer may thin the bundle against.
  haves: string[];
  // Byte progress for a caller that reports it: once with 0 when the
  // peer announces the size, then coalesced to about half a percent
  // or 100ms between reports (every frame is an IPC round trip and a
  // render), and always once more at the end.
  onProgress?: (bytes: number, totalBytes: number) => void;
}

// Where a fetched ref lands locally: capture refs keep their name,
// branch refs land under refs/shigomori/incoming/<branch>. Never a
// local branch -- `sm bundle unpack` enforces the refs/shigomori/
// destination fail-closed, this mapping just picks the names.
function landingRefspec(ref: string): string {
  const dst = ref.startsWith("refs/shigomori/")
    ? ref
    : `refs/shigomori/incoming/${ref.slice("refs/heads/".length)}`;
  return `${ref}:${dst}`;
}

// Sequential chunk loop (one request in flight), abort on any error
// (best effort -- the host's idle sweep is the backstop), temp file
// always removed. The peer parameter is the transfer slice of a peer's
// sync client (a subset of host/ipc/peerSync.ts's PeerSyncApi) --
// window.api-shaped device apis and a bare contract client both
// satisfy it.
export async function fetchBundleFromPeer(
  peer: Pick<
    Client<typeof syncContract>,
    "bundleStart" | "bundleChunk" | "bundleAbort"
  >,
  input: FetchBundleInput,
): Promise<{ fetched: { ref: string; commit: string }[] }> {
  const project = findProjectOrThrow(input.targetProjectId);
  // Re-parsed here because the byte count flows into the progress
  // frames' strict schema and bounds the loop below: the peer's own
  // output validation is not this device's wall.
  const start = SyncBundleStartResultSchema.parse(
    await peer.bundleStart({
      projectId: input.sourceProjectId,
      refs: input.refs,
      haves: input.haves,
    }),
  );
  input.onProgress?.(0, start.bytes);
  let lastReportedMark = 0;
  let lastReportedAt = Date.now();
  const report = (bytes: number, final: boolean) => {
    if (input.onProgress === undefined) return;
    const mark = Math.floor((bytes / Math.max(1, start.bytes)) * 200);
    const now = Date.now();
    if (!final && mark === lastReportedMark && now - lastReportedAt < 100) {
      return;
    }
    lastReportedMark = mark;
    lastReportedAt = now;
    input.onProgress(bytes, start.bytes);
  };
  const dir = await mkdtemp(join(tmpdir(), "sm-sync-recv-"));
  try {
    const path = join(dir, "incoming.bundle");
    const handle = await open(path, "w");
    let offset = 0;
    try {
      let eof = false;
      while (!eof) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        const chunk = await peer.bundleChunk({
          transferId: start.transferId,
          offset,
        });
        const data = Buffer.from(chunk.dataB64, "base64");
        // A peer that stops making progress or overshoots its own
        // announced size is broken; bail instead of looping/growing.
        if (!chunk.eof && data.length === 0) {
          throw new Error("bundle transfer stalled (empty non-final chunk)");
        }
        if (offset + data.length > start.bytes) {
          throw new Error("bundle transfer overran the announced size");
        }
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        await handle.write(data, 0, data.length, offset);
        offset += data.length;
        eof = chunk.eof;
        report(offset, eof);
      }
    } finally {
      await handle.close();
    }
    if (offset !== start.bytes) {
      throw new Error(
        `bundle transfer incomplete: got ${offset} of ${start.bytes} bytes`,
      );
    }
    const refspecs = input.refs.map(landingRefspec);
    return await bundleUnpackViaCli(project, path, refspecs);
  } catch (error) {
    // On the success path the host already dropped the transfer at
    // eof; this only tells it a giving-up receiver is done. Best
    // effort: abort is idempotent and the idle sweep backstops it.
    await peer.bundleAbort({ transferId: start.transferId }).catch(() => {});
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
