// Sender side of the transfer's push direction: builds a bundle of
// local refs (thinned by the peer's tips) through the CLI, streams it
// into the peer's sync:pushStart / pushChunk / pushFinish, and has the
// peer unpack it under its refs/shigomori/ namespace. The mirror of
// fetchBundleFromPeer, for the git follower shipping local commits to
// the device it mirrors with.
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option } from "effect";
import type { syncContract } from "@shared/ipc/modules/sync";
import type { Client } from "@shared/ipc/types";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import type { Project } from "@shared/schemas";
import { bundleCreateViaCli } from "@host/ipc/cliDelegate";
import { hostAttempt } from "@host/runtime";
import { coalescedProgress, pumpChunks } from "./chunkWindow";
import { type Fetched, landingRefspec } from "./fetchBundle";
import { scopedFile, scopedTempDir } from "./scopedFiles";

export interface PushBundleInput {
  localProject: Project;
  // The project id on the PEER to unpack into.
  peerProjectId: string;
  // Allowlisted full refs to ship. They land on the peer under the
  // same names fetchBundleFromPeer uses (branches under
  // refs/shigomori/incoming/, app refs as they are).
  refs: readonly string[];
  // Tips the peer already holds, thinning the bundle. The caller must
  // not name a ref whose tip is covered by a have: `git bundle create`
  // drops such a ref silently and the unpack would then miss it.
  haves: readonly string[];
  // Byte progress, as fetchBundleFromPeer reports it: once with 0 when
  // the size is known, then as chunks are answered.
  onProgress?: (bytes: number, totalBytes: number) => void;
}

// Sends the bundle's bytes as chunks in offset order. Against a host
// that said it takes them pipelined, several ride the wire at once
// (chunkWindow.ts), sent in order and answered in any. Against an
// older host each chunk waits for the last one's answer, which is the
// only order that host accepts. Interruptible at every chunk.
export const sendChunks = (
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
): Effect.Effect<void, unknown> =>
  Effect.suspend(() => {
    let sent = 0;
    let offset = 0;
    // The next chunk, read only once the window has room for it.
    const nextChunk = Effect.gen(function* () {
      if (offset >= bytes) return Option.none();
      // A buffer per chunk: the last one is still being encoded and
      // sent when the next is read. Unzeroed, since only the bytes the
      // read filled are ever used.
      const buffer = Buffer.allocUnsafe(
        Math.min(WIRE_CHUNK_BYTES, bytes - offset),
      );
      const at = offset;
      const { bytesRead } = yield* hostAttempt(() =>
        handle.read(buffer, 0, buffer.length, at),
      );
      if (bytesRead === 0) {
        return yield* Effect.fail(new Error("bundle shrank while sending"));
      }
      offset += bytesRead;
      return Option.some(
        hostAttempt(() =>
          peer.pushChunk({
            transferId,
            offset: at,
            dataB64: buffer.subarray(0, bytesRead).toString("base64"),
          }),
        ).pipe(
          Effect.map(() => {
            sent += bytesRead;
            onSent?.(sent, sent >= bytes);
            return bytesRead;
          }),
        ),
      );
    });
    return pumpChunks(WIRE_CHUNK_BYTES, nextChunk, {
      maxInFlight: pipelined ? undefined : 1,
    });
  });

// The same loop for a Promise-side caller. Exported for the wire
// benchmark (test/bench/wire.mjs).
export function sendBundleChunks(
  peer: Pick<Client<typeof syncContract>, "pushChunk">,
  transferId: string,
  handle: Pick<FileHandle, "read">,
  bytes: number,
  options: {
    pipelined: boolean;
    onSent?: (bytes: number, final: boolean) => void;
  },
): Promise<void> {
  return Effect.runPromise(
    sendChunks(peer, transferId, handle, bytes, options),
  );
}

type PushBundlePeer = Pick<
  Client<typeof syncContract>,
  "pushStart" | "pushChunk" | "pushFinish"
>;

// The push in two steps: the bundle is built into a temp dir this
// fiber owns (scopedFiles.ts), gone the moment the staging ends
// however it ended, and every chunk is sent; then the finish, which
// the peer answers by unpacking the bundle under refs/shigomori/. The
// finish is handed back rather than run here so a caller can run it
// inside the same uninterruptible step as the landing that consumes
// (and sweeps) what it unpacked: with the two apart, a caller leaving
// between them would leave the unpacked ref on the peer, where a
// later transfer of a branch nested under that name fails on the ref
// name clash. The peer's half of a push left staged lives in its own
// registry, swept there if this side never finishes it.
export const stageBundle = (
  peer: PushBundlePeer,
  input: PushBundleInput,
): Effect.Effect<Effect.Effect<Fetched, unknown>, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* scopedTempDir("sm-sync-push-");
      const path = join(dir.value, "push.bundle");
      const created = yield* hostAttempt(() =>
        bundleCreateViaCli(input.localProject, path, input.refs, input.haves),
      );
      const { transferId, pipelined } = yield* hostAttempt(() =>
        peer.pushStart({
          projectId: input.peerProjectId,
          bytes: created.bytes,
        }),
      );
      input.onProgress?.(0, created.bytes);
      yield* Effect.scoped(
        Effect.flatMap(scopedFile(path, "r"), (handle) =>
          sendChunks(peer, transferId, handle.value, created.bytes, {
            pipelined: pipelined === true,
            onSent: coalescedProgress(created.bytes, input.onProgress),
          }),
        ),
      );
      return hostAttempt(() =>
        peer.pushFinish({
          transferId,
          refspecs: input.refs.map(landingRefspec),
        }),
      );
    }),
  );

// The two steps as one, for a caller with no landing of its own.
export const pushBundle = (
  peer: PushBundlePeer,
  input: PushBundleInput,
): Effect.Effect<Fetched, unknown> =>
  Effect.flatMap(stageBundle(peer, input), (finish) => finish);

export function pushBundleToPeer(
  peer: PushBundlePeer,
  input: PushBundleInput,
): Promise<Fetched> {
  return Effect.runPromise(pushBundle(peer, input));
}
