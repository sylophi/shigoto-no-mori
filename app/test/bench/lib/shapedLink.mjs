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
import { connect } from "node:net";
import { startLoopbackServer } from "../../lib/checkKit.mjs";

export async function startShapedLink({
  targetPort,
  oneWayDelayMs,
  upBytesPerSec,
  downBytesPerSec,
}) {
  const counters = { up: 0, down: 0 };

  // One direction of one connection. `free` is when the link finishes
  // serializing everything queued so far.
  function pipe(from, to, bytesPerSec, count) {
    let free = 0;
    from.on("data", (chunk) => {
      count(chunk.length);
      const now = performance.now();
      const start = Math.max(now, free);
      free = start + (chunk.length / bytesPerSec) * 1000;
      const arrive = free + oneWayDelayMs;
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, arrive - now);
    });
    from.on("end", () => {
      const wait = Math.max(performance.now(), free) + oneWayDelayMs;
      setTimeout(() => to.end(), wait - performance.now());
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
