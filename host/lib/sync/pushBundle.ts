// Sender side of the transfer's push direction: builds a bundle of
// local refs (thinned by the peer's tips) through the CLI, streams it
// into the peer's sync:pushStart / pushChunk / pushFinish, and has the
// peer unpack it under its refs/shigomori/ namespace. The mirror of
// fetchBundleFromPeer, for the git follower shipping local commits to
// the device it mirrors with.
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { syncContract } from "@shared/ipc/modules/sync";
import type { Client } from "@shared/ipc/types";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import type { Project } from "@shared/schemas";
import { bundleCreateViaCli } from "@host/ipc/cliDelegate";
import { landingRefspec } from "./fetchBundle";

export interface PushBundleInput {
  localProject: Project;
  // The project id on the PEER to unpack into.
  peerProjectId: string;
  // Allowlisted full refs to ship; they land on the peer under the
  // same names fetchBundleFromPeer uses (branches under
  // refs/shigomori/incoming/, app refs as they are).
  refs: string[];
  // Tips the peer already holds, thinning the bundle. The caller must
  // not name a ref whose tip is covered by a have: `git bundle create`
  // drops such a ref silently and the unpack would then miss it.
  haves: string[];
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
    const { transferId } = await peer.pushStart({
      projectId: input.peerProjectId,
      bytes: created.bytes,
    });
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(WIRE_CHUNK_BYTES);
      let offset = 0;
      while (offset < created.bytes) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        const { bytesRead } = await handle.read(
          buffer,
          0,
          WIRE_CHUNK_BYTES,
          offset,
        );
        if (bytesRead === 0) throw new Error("bundle shrank while sending");
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        await peer.pushChunk({
          transferId,
          offset,
          dataB64: buffer.subarray(0, bytesRead).toString("base64"),
        });
        offset += bytesRead;
      }
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
