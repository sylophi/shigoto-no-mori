// Sender side of the transfer's push direction: builds a bundle of
// local refs (thinned by the peer's tips) through the CLI, streams it
// into the peer's sync:pushStart / pushChunk / pushFinish, and has the
// peer unpack it under its refs/shigomori/ namespace. The mirror of
// fetchBundleFromPeer, for the git follower shipping local commits to
// the device it mirrors with.
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { syncContract } from "@shared/ipc/modules/sync";
import type { Client } from "@shared/ipc/types";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import type { Project } from "@shared/schemas";
import { bundleCreateViaCli } from "@host/ipc/cliDelegate";
import { coalescedProgress, createChunkWindow } from "./chunkWindow";
import { landingRefspec } from "./fetchBundle";

export interface PushBundleInput {
  localProject: Project;
  // The project id on the PEER to unpack into.
  peerProjectId: string;
  // Allowlisted full refs to ship. They land on the peer under the
  // same names fetchBundleFromPeer uses (branches under
  // refs/shigomori/incoming/, app refs as they are).
  refs: string[];
  // Tips the peer already holds, thinning the bundle. The caller must
  // not name a ref whose tip is covered by a have: `git bundle create`
  // drops such a ref silently and the unpack would then miss it.
  haves: string[];
  // Byte progress, as fetchBundleFromPeer reports it: once with 0 when
  // the size is known, then as chunks are answered.
  onProgress?: (bytes: number, totalBytes: number) => void;
}

// Sends the bundle's bytes as chunks in offset order. Against a host
// that said it takes them pipelined, several ride the wire at once
// (chunkWindow.ts), sent in order and answered in any. Against an
// older host each chunk waits for the last one's answer, which is the
// only order that host accepts. Exported for the wire benchmark
// (test/bench/wire.mjs).
export async function sendBundleChunks(
  peer: Pick<Client<typeof syncContract>, "pushChunk">,
  transferId: string,
  handle: Pick<FileHandle, "read">,
  bytes: number,
  {
    pipelined,
    onSent,
  }: {
    pipelined: boolean;
    // The running total of bytes the peer has answered for.
    onSent?: (bytes: number, final: boolean) => void;
  },
): Promise<void> {
  const window = createChunkWindow(WIRE_CHUNK_BYTES, {
    maxInFlight: pipelined ? undefined : 1,
  });
  let sent = 0;
  try {
    for (let offset = 0; offset < bytes;) {
      // A buffer per chunk: the last one is still being encoded and
      // sent when the next is read. Unzeroed, since only the bytes the
      // read filled are ever used.
      const buffer = Buffer.allocUnsafe(
        Math.min(WIRE_CHUNK_BYTES, bytes - offset),
      );
      // oxlint-disable-next-line no-await-in-loop -- chunks are read in order
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) throw new Error("bundle shrank while sending");
      const at = offset;
      // oxlint-disable-next-line no-await-in-loop -- the window's backpressure
      await window.add(async () => {
        await peer.pushChunk({
          transferId,
          offset: at,
          dataB64: buffer.subarray(0, bytesRead).toString("base64"),
        });
        sent += bytesRead;
        onSent?.(sent, sent >= bytes);
        return bytesRead;
      });
      offset += bytesRead;
    }
    await window.drain();
  } finally {
    await window.settled();
  }
}

export async function pushBundleToPeer(
  peer: Pick<
    Client<typeof syncContract>,
    "pushStart" | "pushChunk" | "pushFinish"
  >,
  input: PushBundleInput,
): Promise<{ fetched: { ref: string; commit: string }[] }> {
  const dir = await mkdtemp(join(tmpdir(), "sm-sync-push-"));
  try {
    const path = join(dir, "push.bundle");
    const created = await bundleCreateViaCli(
      input.localProject,
      path,
      input.refs,
      input.haves,
    );
    const { transferId, pipelined } = await peer.pushStart({
      projectId: input.peerProjectId,
      bytes: created.bytes,
    });
    input.onProgress?.(0, created.bytes);
    const handle = await open(path, "r");
    try {
      await sendBundleChunks(peer, transferId, handle, created.bytes, {
        pipelined: pipelined === true,
        onSent: coalescedProgress(created.bytes, input.onProgress),
      });
    } finally {
      await handle.close();
    }
    return await peer.pushFinish({
      transferId,
      refspecs: input.refs.map(landingRefspec),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
