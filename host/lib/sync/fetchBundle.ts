// Receiver side of the device-sync transfer plumbing: drives a peer's
// sync:bundleStart / sync:bundleChunk surface into a local temp file,
// then unpacks it into this device's repo via the CLI. Exported for
// the sync orchestration (slice C); no UI here.
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { syncContract } from "@shared/ipc/modules/sync";
import type { Client } from "@shared/ipc/types";
import { bundleUnpackViaCli } from "@host/ipc/cliDelegate";
import { findProjectOrThrow } from "@host/lib/projects";

// The transfer slice of a peer's sync client -- window.api-shaped
// device apis and a bare contract client both satisfy it.
export type PeerSyncApi = Pick<
  Client<typeof syncContract>,
  "bundleStart" | "bundleChunk" | "bundleAbort"
>;

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
// always removed.
export async function fetchBundleFromPeer(
  peer: PeerSyncApi,
  input: FetchBundleInput,
): Promise<{ fetched: { ref: string; commit: string }[] }> {
  const project = findProjectOrThrow(input.targetProjectId);
  const start = await peer.bundleStart({
    projectId: input.sourceProjectId,
    refs: input.refs,
    haves: input.haves,
  });
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
