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
const WINDOW_SECONDS = 0.35;
const MIN_CHUNKS_IN_FLIGHT = 2;
const MAX_CHUNKS_IN_FLIGHT = 8;

export type ChunkWindow = {
  // Starts one chunk (the task resolves to the bytes it moved) and
  // resolves once there is room to start the next. Rejects with the
  // first failure of any chunk, as soon as one is known, so a caller
  // stops feeding a transfer that is already lost.
  add(chunk: () => Promise<number>): Promise<void>;
  // Resolves once every chunk started so far has landed, or rejects
  // with the first failure.
  drain(): Promise<void>;
  // For a finally: resolves once no chunk is in flight, failed or not,
  // so whatever they write to may be closed.
  settled(): Promise<void>;
};

// A window for a transfer that starts now, moving `strideBytes` per
// chunk. `maxInFlight: 1` is the sequential transfer an older peer
// needs.
export function createChunkWindow(
  strideBytes: number,
  { maxInFlight = MAX_CHUNKS_IN_FLIGHT }: { maxInFlight?: number } = {},
): ChunkWindow {
  const startedAt = Date.now();
  let doneBytes = 0;
  // Never rejecting: a failure is recorded, and surfaced by the next
  // add or the drain.
  const inFlight = new Set<Promise<void>>();
  let failure: { error: unknown } | null = null;
  const limit = (): number => {
    const seconds = Math.max(0.05, (Date.now() - startedAt) / 1000);
    const chunks = ((doneBytes / seconds) * WINDOW_SECONDS) / strideBytes;
    return Math.min(
      maxInFlight,
      Math.max(MIN_CHUNKS_IN_FLIGHT, Math.round(chunks) + 1),
    );
  };
  const throwFailure = (): void => {
    if (failure !== null) throw failure.error;
  };
  return {
    async add(chunk) {
      throwFailure();
      const landed = chunk()
        .then(
          (bytes) => {
            doneBytes += bytes;
          },
          (error: unknown) => {
            failure ??= { error };
          },
        )
        .then(() => {
          inFlight.delete(landed);
        });
      inFlight.add(landed);
      while (inFlight.size >= limit()) {
        // oxlint-disable-next-line no-await-in-loop -- the window's backpressure
        await Promise.race(inFlight);
        throwFailure();
      }
      throwFailure();
    },
    async drain() {
      await Promise.all(inFlight);
      throwFailure();
    },
    async settled() {
      await Promise.all(inFlight);
    },
  };
}
