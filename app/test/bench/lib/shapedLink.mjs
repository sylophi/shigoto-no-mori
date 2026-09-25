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
import { connect, createServer } from "node:net";

export function startShapedLink({
  targetPort,
  oneWayDelayMs,
  upBytesPerSec,
  downBytesPerSec,
}) {
  const counters = { up: 0, down: 0 };
  const sockets = new Set();

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

  const server = createServer((client) => {
    const upstream = connect(targetPort, "127.0.0.1");
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    pipe(client, upstream, upBytesPerSec, (n) => (counters.up += n));
    pipe(upstream, client, downBytesPerSec, (n) => (counters.down += n));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        counters,
        reset() {
          counters.up = 0;
          counters.down = 0;
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}
