// The window both directions of a bundle transfer move their chunks
// through (fetchBundle.ts, pushBundle.ts): how many ride the wire at
// once, and the bookkeeping of the ones that do. One at a time leaves
// the link idle for a round trip per chunk, which over a tunnel is a
// large part of the transfer. But every chunk in flight is also bytes
// queued on the one socket the UI's own calls to that device share, so
// the window is sized in TIME: about this many seconds of the measured
// rate, plus one. A slow uplink keeps two in flight (the link stays
// busy, a call waits behind little more than it did), a fast one grows
// toward the cap.
import { Cause, Clock, Effect, Exit, Option, Queue } from "effect";

const WINDOW_SECONDS = 0.35;
const MIN_CHUNKS_IN_FLIGHT = 2;
const MAX_CHUNKS_IN_FLIGHT = 8;

// Moves every chunk `nextChunk` hands out, `strideBytes` each, with as
// many in flight as the window allows at the moment each one starts.
// A queue-fed pump: every chunk runs on a fiber of its own and reports
// on `landed` when it is done, and the pump takes from `landed`
// whenever the window is full. The window is re-read on every take, so
// it grows with the measured rate while the transfer runs, which is
// what a fixed `Effect.forEach` concurrency could not do.
//
// The first chunk to fail is the transfer's failure, as soon as it is
// known: no further chunk is started, and the pump fails with that
// chunk's own cause. However the pump ends (done, failed, or its
// caller interrupted), the chunks still in flight are interrupted and
// waited for before it returns, so whatever they write to may be
// closed right after. `maxInFlight: 1` is the sequential transfer an
// older peer needs.
//
// `nextChunk` is asked for the next chunk only once there is room for
// it, so a producer that reads the chunk's bytes (the push) reads no
// further ahead than the window. Each chunk starts at once when forked,
// so chunks begin in the order they were handed out.
export const pumpChunks = <E, R>(
  strideBytes: number,
  nextChunk: Effect.Effect<Option.Option<Effect.Effect<number, E, R>>, E, R>,
  { maxInFlight = MAX_CHUNKS_IN_FLIGHT }: { maxInFlight?: number } = {},
): Effect.Effect<void, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const startedAt = yield* Clock.currentTimeMillis;
      let doneBytes = 0;
      let inFlight = 0;
      // The first chunk failure, recorded by the chunk itself and
      // surfaced by the pump at its next look.
      let failure: Cause.Cause<E> | null = null;
      // One signal per chunk that ended, however it ended.
      const landed = yield* Queue.unbounded<void>();
      const limit = Effect.map(Clock.currentTimeMillis, (now) => {
        const seconds = Math.max(0.05, (now - startedAt) / 1000);
        const chunks = ((doneBytes / seconds) * WINDOW_SECONDS) / strideBytes;
        return Math.min(
          maxInFlight,
          Math.max(MIN_CHUNKS_IN_FLIGHT, Math.round(chunks) + 1),
        );
      });
      const throwFailure = Effect.suspend(() =>
        failure === null ? Effect.void : Effect.failCause(failure),
      );
      const settle = (exit: Exit.Exit<number, E>) =>
        Effect.suspend(() => {
          inFlight -= 1;
          if (Exit.isSuccess(exit)) doneBytes += exit.value;
          else failure ??= exit.cause;
          return Queue.offer(landed, undefined);
        });
      while (true) {
        yield* throwFailure;
        const next = yield* nextChunk;
        if (Option.isNone(next)) break;
        inFlight += 1;
        yield* next.value.pipe(
          Effect.exit,
          Effect.flatMap(settle),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        // The window's backpressure: wait for a chunk to land while the
        // window, as the rate now stands, is full.
        while (inFlight >= (yield* limit)) {
          yield* Queue.take(landed);
          yield* throwFailure;
        }
      }
      // oxlint-disable-next-line no-unmodified-loop-condition -- the chunk fibers count it down
      while (inFlight > 0) yield* Queue.take(landed);
      yield* throwFailure;
    }),
  );

// Byte progress for a caller that reports it, coalesced to about half
// a percent or 100ms between reports (every frame is an IPC round trip
// and a render), and always once more at the end.
export function coalescedProgress(
  totalBytes: number,
  onProgress: ((bytes: number, totalBytes: number) => void) | undefined,
): (bytes: number, final: boolean) => void {
  let lastReportedMark = 0;
  let lastReportedAt = Date.now();
  return (bytes, final) => {
    if (onProgress === undefined) return;
    const mark = Math.floor((bytes / Math.max(1, totalBytes)) * 200);
    const now = Date.now();
    if (!final && mark === lastReportedMark && now - lastReportedAt < 100) {
      return;
    }
    lastReportedMark = mark;
    lastReportedAt = now;
    onProgress(bytes, totalBytes);
  };
}
