// Receiver side of the device-sync transfer plumbing: drives a peer's
// sync:bundleStart / sync:bundleChunk surface into a local temp file,
// then unpacks it into this device's repo via the CLI. Exported for
// the sync orchestration (slice C); no UI here.
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SyncBundleStartResultSchema,
  type syncContract,
} from "@shared/ipc/modules/sync";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import type { Client } from "@shared/ipc/types";
import { bundleUnpackViaCli } from "@host/ipc/cliDelegate";
import { findProjectOrThrow } from "@host/lib/projects";
import {
  type ChunkWindow,
  coalescedProgress,
  createChunkWindow,
} from "./chunkWindow";

// Where the bundle unpacks: a project in THIS device's registry, or a
// repository at a path not registered yet (the clone from a peer,
// cloneFromPeer.ts, which registers it once it is a checkout). The CLI
// takes either.
type UnpackTarget = { targetProjectId: string } | { repoPath: string };

export type FetchBundleInput = UnpackTarget & {
  // The project id on the PEER (ids differ per device registry;
  // identity matching across devices is the orchestration's job).
  sourceProjectId: string;
  // Allowlisted full refs to request (refs/heads/<branch> or
  // refs/shigomori/dirty/<worktreeId>); validated peer-side by the
  // contract schema and again by the CLI.
  refs: string[];
  // Local tips the peer may thin the bundle against.
  haves: string[];
  // Byte progress for a caller that reports it: once with 0 when the
  // peer announces the size, then coalesced (chunkWindow.ts).
  onProgress?: (bytes: number, totalBytes: number) => void;
};

// Where a fetched branch lands locally, and where the orchestrations
// look for it: never the branch itself.
export function incomingRefFor(branch: string): string {
  return `refs/shigomori/incoming/${branch}`;
}

// Where a fetched ref lands locally: capture refs keep their name,
// branch refs land under refs/shigomori/incoming/<branch>. Never a
// local branch -- `sm bundle unpack` enforces the refs/shigomori/
// destination fail-closed, this mapping just picks the names.
export function landingRefspec(ref: string): string {
  const dst = ref.startsWith("refs/shigomori/")
    ? ref
    : incomingRefFor(ref.slice("refs/heads/".length));
  return `${ref}:${dst}`;
}

// Windowed chunk loop: writes the announced bytes of a started
// transfer into `handle` and resolves once all of them landed. The
// first chunk goes alone. When it is the wire's chunk size, every later
// offset is a multiple of it and the chunks between the first and the
// last ride a window (chunkWindow.ts). A short read on the peer leaves
// a gap, which is asked for again at its own offset. The final chunk
// is asked for only once every other one has landed: a host drops the
// transfer (and its file) on serving eof, and must not do that under a
// read still in flight. A first chunk of any other size is a peer that
// cuts its chunks differently, and that transfer goes on one chunk at
// a time, each offset following from the last answer, as every
// transfer once did. Exported for the wire benchmark
// (test/bench/wire.mjs), which drives it over a shaped link.
export async function receiveBundleChunks(
  peer: Pick<Client<typeof syncContract>, "bundleChunk">,
  transfer: { transferId: string; bytes: number },
  handle: Pick<FileHandle, "write">,
  report: (bytes: number, final: boolean) => void,
): Promise<void> {
  let received = 0;
  let window: ChunkWindow | null = null;
  try {
    // One chunk: request, check it against the announced size, write it
    // at its own offset.
    const take = async (
      offset: number,
    ): Promise<{ bytes: number; eof: boolean }> => {
      const chunk = await peer.bundleChunk({
        transferId: transfer.transferId,
        offset,
      });
      const data = Buffer.from(chunk.dataB64, "base64");
      // A peer that stops making progress or overshoots its own
      // announced size is broken; bail instead of looping/growing.
      if (!chunk.eof && data.length === 0) {
        throw new Error("bundle transfer stalled (empty non-final chunk)");
      }
      if (offset + data.length > transfer.bytes) {
        throw new Error("bundle transfer overran the announced size");
      }
      await handle.write(data, 0, data.length, offset);
      received += data.length;
      report(received, chunk.eof);
      return { bytes: data.length, eof: chunk.eof };
    };
    // The bytes from `offset` up to `end`, however many answers they
    // take: a short one is followed by a request for the rest.
    const takeThrough = async (
      offset: number,
      end: number,
    ): Promise<number> => {
      for (let at = offset; at < end;) {
        // oxlint-disable-next-line no-await-in-loop -- each offset follows the last answer
        const { bytes, eof } = await take(at);
        at += bytes;
        if (at > end || (eof && at < end)) {
          throw new Error("bundle transfer chunk did not match its offset");
        }
      }
      return end - offset;
    };

    const first = await take(0);
    if (!first.eof && first.bytes === WIRE_CHUNK_BYTES) {
      const stride = WIRE_CHUNK_BYTES;
      const lastOffset = Math.floor((transfer.bytes - 1) / stride) * stride;
      window = createChunkWindow(stride);
      for (let offset = stride; offset < lastOffset; offset += stride) {
        const at = offset;
        // oxlint-disable-next-line no-await-in-loop -- the window's backpressure
        await window.add(() => takeThrough(at, at + stride));
      }
      await window.drain();
      await takeThrough(lastOffset, transfer.bytes);
    } else if (!first.eof) {
      await takeThrough(first.bytes, transfer.bytes);
    }
  } finally {
    await window?.settled();
  }
  if (received !== transfer.bytes) {
    throw new Error(
      `bundle transfer incomplete: got ${received} of ${transfer.bytes} bytes`,
    );
  }
}

// Abort on any error (best effort -- the host's idle sweep is the
// backstop), temp file always removed. The peer parameter is the
// transfer slice of a peer's sync client (a subset of
// host/ipc/peerSync.ts's PeerSyncApi) -- window.api-shaped device apis
// and a bare contract client both satisfy it.
export async function fetchBundleFromPeer(
  peer: Pick<
    Client<typeof syncContract>,
    "bundleStart" | "bundleChunk" | "bundleAbort"
  >,
  input: FetchBundleInput,
): Promise<{ fetched: { ref: string; commit: string }[] }> {
  const target =
    "targetProjectId" in input
      ? findProjectOrThrow(input.targetProjectId)
      : { path: input.repoPath };
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
  const report = coalescedProgress(start.bytes, input.onProgress);
  const dir = await mkdtemp(join(tmpdir(), "sm-sync-recv-"));
  try {
    const path = join(dir, "incoming.bundle");
    const handle = await open(path, "w");
    try {
      await receiveBundleChunks(peer, start, handle, report);
    } finally {
      await handle.close();
    }
    const refspecs = input.refs.map(landingRefspec);
    return await bundleUnpackViaCli(target, path, refspecs);
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
