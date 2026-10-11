// A loopback TCP proxy that behaves like an internet path: a fixed
// one-way delay and a per-direction bandwidth cap, so a benchmark
// driving the real socket binding sees round trips and serialization
// time instead of loopback's zero of both. It also counts the bytes
// each direction carried, which is the number compression and
// encoding changes move.
//
// The model is a serializing link: each chunk departs when the link is
// free (previous departure plus that chunk's bytes at the cap) and
// arrives one delay later. No loss, no jitter, no congestion control,
// so results are repeatable and read as a best case for the real path.
import { connect, type Socket } from "node:net";
import { startLoopbackServer } from "../../lib/checkKit.mts";

export type ShapedLinkOpts = {
  targetPort: number;
  oneWayDelayMs: number;
  upBytesPerSec: number;
  downBytesPerSec: number;
};

export type ShapedLink = {
  url: string;
  counters: { up: number; down: number };
  reset(): void;
  close(): Promise<void>;
};

export async function startShapedLink({
  targetPort,
  oneWayDelayMs,
  upBytesPerSec,
  downBytesPerSec,
}: ShapedLinkOpts): Promise<ShapedLink> {
  const counters = { up: 0, down: 0 };

  // One direction of one connection. `free` is when the link finishes
  // serializing everything queued so far. Chunks leave in the order they
  // came, from one queue: a timer each could fire out of order by a
  // fraction of a millisecond, and a byte stream must not.
  function pipe(
    from: Socket,
    to: Socket,
    bytesPerSec: number,
    count: (bytes: number) => void,
  ): void {
    let free = 0;
    const queue: { chunk: Buffer | null; arrive: number }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deliver = (): void => {
      timer = null;
      const now = performance.now();
      while (queue.length > 0 && (queue[0]?.arrive ?? 0) <= now) {
        const { chunk } = queue.shift() as { chunk: Buffer | null };
        if (to.destroyed) continue;
        if (chunk === null) to.end();
        else to.write(chunk);
      }
      schedule();
    };
    const schedule = (): void => {
      const head = queue[0];
      if (timer !== null || head === undefined) return;
      timer = setTimeout(deliver, Math.max(0, head.arrive - performance.now()));
    };
    from.on("data", (chunk: Buffer) => {
      count(chunk.length);
      const now = performance.now();
      const start = Math.max(now, free);
      free = start + (chunk.length / bytesPerSec) * 1000;
      queue.push({ chunk, arrive: free + oneWayDelayMs });
      schedule();
    });
    from.on("end", () => {
      queue.push({
        chunk: null,
        arrive: Math.max(performance.now(), free) + oneWayDelayMs,
      });
      schedule();
    });
    from.on("error", () => to.destroy());
  }

  const link = await startLoopbackServer((client, hold) => {
    const upstream = hold(connect(targetPort, "127.0.0.1"));
    for (const socket of [client, upstream]) socket.setNoDelay(true);
    pipe(client, upstream, upBytesPerSec, (n) => (counters.up += n));
    pipe(upstream, client, downBytesPerSec, (n) => (counters.down += n));
  });

  return {
    url: `ws://127.0.0.1:${link.port}`,
    counters,
    reset() {
      counters.up = 0;
      counters.down = 0;
    },
    close: link.close,
  };
}
