// Receiver side of the device-sync transfer plumbing: drives a peer's
// sync:bundleStart / sync:bundleChunk surface into a local temp file,
// then unpacks it into this device's repo via the CLI. Exported for
// the sync orchestration (slice C); no UI here.
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  SyncBundleStartResultSchema,
  type syncContract,
} from "@shared/ipc/modules/sync";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import type { Client } from "@shared/ipc/types";
import { bundleUnpackViaCli } from "@host/ipc/cliDelegate";
import { findProjectOrThrow } from "@host/lib/projects";
import { hostAttempt } from "@host/runtime";
import { coalescedProgress, pumpChunks } from "./chunkWindow";
import { scopedFile, scopedTempDir } from "./scopedFiles";

export interface FetchBundleInput {
  // The project id on the PEER (ids differ per device registry;
  // identity matching across devices is the orchestration's job).
  sourceProjectId: string;
  // The project id in THIS device's registry to unpack into.
  targetProjectId: string;
  // Allowlisted full refs to request (refs/heads/<branch> or
  // refs/shigomori/dirty/<worktreeId>); validated peer-side by the
  // contract schema and again by the CLI.
  refs: readonly string[];
  // Local tips the peer may thin the bundle against.
  haves: readonly string[];
  // Byte progress for a caller that reports it: once with 0 when the
  // peer announces the size, then coalesced (chunkWindow.ts).
  onProgress?: (bytes: number, totalBytes: number) => void;
}

// Where a fetched ref lands locally: capture refs keep their name,
// branch refs land under refs/shigomori/incoming/<branch>. Never a
// local branch -- `sm bundle unpack` enforces the refs/shigomori/
// destination fail-closed, this mapping just picks the names.
export function landingRefspec(ref: string): string {
  const dst = ref.startsWith("refs/shigomori/")
    ? ref
    : `refs/shigomori/incoming/${ref.slice("refs/heads/".length)}`;
  return `${ref}:${dst}`;
}

// Windowed chunk loop: writes the announced bytes of a started
// transfer into `handle` and succeeds once all of them landed. The
// first chunk goes alone. When it is the wire's chunk size, every later
// offset is a multiple of it and the chunks between the first and the
// last ride a window (chunkWindow.ts). A short read on the peer leaves
// a gap, which is asked for again at its own offset. The final chunk
// is asked for only once every other one has landed: a host drops the
// transfer (and its file) on serving eof, and must not do that under a
// read still in flight. A first chunk of any other size is a peer that
// cuts its chunks differently, and that transfer goes on one chunk at
// a time, each offset following from the last answer, as every
// transfer once did. Interruptible at every chunk: a caller that
// leaves stops the loop, and the window waits for no answer.
export const receiveChunks = (
  peer: Pick<Client<typeof syncContract>, "bundleChunk">,
  transfer: { transferId: string; bytes: number },
  handle: Pick<FileHandle, "write">,
  report: (bytes: number, final: boolean) => void,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let received = 0;
    // One chunk: request, check it against the announced size, write it
    // at its own offset.
    const take = (offset: number) =>
      Effect.gen(function* () {
        const chunk = yield* hostAttempt(() =>
          peer.bundleChunk({ transferId: transfer.transferId, offset }),
        );
        const data = Buffer.from(chunk.dataB64, "base64");
        // A peer that stops making progress or overshoots its own
        // announced size is broken; bail instead of looping/growing.
        if (!chunk.eof && data.length === 0) {
          return yield* Effect.fail(
            new Error("bundle transfer stalled (empty non-final chunk)"),
          );
        }
        if (offset + data.length > transfer.bytes) {
          return yield* Effect.fail(
            new Error("bundle transfer overran the announced size"),
          );
        }
        yield* hostAttempt(() => handle.write(data, 0, data.length, offset));
        received += data.length;
        report(received, chunk.eof);
        return { bytes: data.length, eof: chunk.eof };
      });
    // The bytes from `offset` up to `end`, however many answers they
    // take: a short one is followed by a request for the rest.
    const takeThrough = (offset: number, end: number) =>
      Effect.gen(function* () {
        for (let at = offset; at < end;) {
          const { bytes, eof } = yield* take(at);
          at += bytes;
          if (at > end || (eof && at < end)) {
            return yield* Effect.fail(
              new Error("bundle transfer chunk did not match its offset"),
            );
          }
        }
        return end - offset;
      });

    const first = yield* take(0);
    if (!first.eof && first.bytes === WIRE_CHUNK_BYTES) {
      const stride = WIRE_CHUNK_BYTES;
      const lastOffset = Math.floor((transfer.bytes - 1) / stride) * stride;
      let offset = stride;
      yield* pumpChunks(
        stride,
        Effect.sync(() => {
          if (offset >= lastOffset) return Option.none();
          const at = offset;
          offset += stride;
          return Option.some(takeThrough(at, at + stride));
        }),
      );
      yield* takeThrough(lastOffset, transfer.bytes);
    } else if (!first.eof) {
      yield* takeThrough(first.bytes, transfer.bytes);
    }
    if (received !== transfer.bytes) {
      return yield* Effect.fail(
        new Error(
          `bundle transfer incomplete: got ${received} of ${transfer.bytes} bytes`,
        ),
      );
    }
  });

// The same loop for a Promise-side caller. Exported for the wire
// benchmark (test/bench/wire.mjs), which drives it over a shaped link.
export function receiveBundleChunks(
  peer: Pick<Client<typeof syncContract>, "bundleChunk">,
  transfer: { transferId: string; bytes: number },
  handle: Pick<FileHandle, "write">,
  report: (bytes: number, final: boolean) => void,
): Promise<void> {
  return Effect.runPromise(receiveChunks(peer, transfer, handle, report));
}

type FetchBundlePeer = Pick<
  Client<typeof syncContract>,
  "bundleStart" | "bundleChunk" | "bundleAbort"
>;

type Fetched = {
  readonly fetched: readonly {
    readonly ref: string;
    readonly commit: string;
  }[];
};

// Abort on any error (best effort -- the host's idle sweep is the
// backstop), temp file always removed, at once when the caller leaves:
// the dir is a resource of this fiber (scopedFiles.ts). The peer
// parameter is the transfer slice of a peer's sync client (a subset of
// host/ipc/peerSync.ts's PeerSyncApi) -- window.api-shaped device apis
// and a bare contract client both satisfy it.
export const fetchBundle = (
  peer: FetchBundlePeer,
  input: FetchBundleInput,
): Effect.Effect<Fetched, unknown> =>
  Effect.gen(function* () {
    const project = yield* hostAttempt(() =>
      findProjectOrThrow(input.targetProjectId),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Re-parsed here because the byte count flows into the progress
        // frames' strict schema and bounds the loop below: the peer's
        // own output validation is not this device's wall. The request
        // is the resource, not its answer: the peer builds the whole
        // bundle before it answers, and an acquire that awaited it
        // would hold a departed caller for as long as that takes
        // (acquireRelease's acquire is uninterruptible). So the promise
        // is made under the scope and awaited interruptibly after, and
        // however this fiber ends short of the eof, the release tells
        // the peer a giving-up receiver is done, once (and if) the
        // transfer was minted. On the success path the host already
        // dropped the transfer at eof. Best effort: abort is idempotent
        // and the idle sweep backstops it. A failure waits for the
        // answer; a caller that left does not wait on the peer.
        const pendingStart = yield* Effect.acquireRelease(
          Effect.sync(() =>
            peer
              .bundleStart({
                projectId: input.sourceProjectId,
                refs: input.refs,
                haves: input.haves,
              })
              .then((answer) =>
                Schema.decodeUnknownSync(SyncBundleStartResultSchema)(answer),
              ),
          ),
          (pending, exit) => {
            const abort = () =>
              pending
                .then((started) =>
                  peer.bundleAbort({ transferId: started.transferId }),
                )
                .catch(() => {});
            if (Exit.isSuccess(exit)) return Effect.void;
            return Cause.hasInterrupts(exit.cause)
              ? Effect.sync(() => void abort())
              : Effect.promise(abort);
          },
        );
        const start = yield* hostAttempt(() => pendingStart);
        input.onProgress?.(0, start.bytes);
        const report = coalescedProgress(start.bytes, input.onProgress);
        const dir = yield* scopedTempDir("sm-sync-recv-");
        const path = join(dir.value, "incoming.bundle");
        yield* Effect.scoped(
          Effect.flatMap(scopedFile(path, "w"), (handle) =>
            receiveChunks(peer, start, handle.value, report),
          ),
        );
        const refspecs = input.refs.map(landingRefspec);
        // Uninterruptible: the unpack is one non-atomic git fetch over
        // several refspecs into refs/shigomori/, and the CLI runs it to
        // its end whatever this fiber does. Left interruptible, a
        // caller leaving would remove the bundle under the fetch still
        // reading it, and the caller's own sweep of the landing refs
        // would race refs still being written.
        return yield* Effect.uninterruptible(
          hostAttempt(() => bundleUnpackViaCli(project, path, refspecs)),
        );
      }),
    );
  });

export function fetchBundleFromPeer(
  peer: FetchBundlePeer,
  input: FetchBundleInput,
): Promise<Fetched> {
  return Effect.runPromise(fetchBundle(peer, input));
}
