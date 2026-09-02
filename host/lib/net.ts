// Socket plumbing shared by the port-forward wire's two halves: the
// host verbs (host/ipc/modules/forward.ts) and the client engine
// (main/portForward/engine.ts), plus the loopback dial the worktree
// port list's liveness probe shares with forward:open.
import { connect, type Socket } from "node:net";

// Resolves once the socket's write buffer drains, or on 'close', which
// releases a wait the socket died under (drain would never fire).
// Awaiting this after a false-returning write paces the writer to what
// the reader actually consumes.
export function waitForDrainOrClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resolve();
    };
    socket.once("drain", done);
    socket.once("close", done);
  });
}

function dialOnce(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const dialing = connect({ host, port });
    const onError = (error: Error) => reject(error);
    dialing.once("error", onError);
    // A wedged listener (SYN dropped, backlog full) answers neither
    // connect nor error: without a deadline the caller hangs forever.
    dialing.setTimeout(timeoutMs, () => {
      dialing.destroy();
      reject(new Error("dial timed out"));
    });
    dialing.once("connect", () => {
      dialing.setTimeout(0);
      dialing.off("error", onError);
      resolve(dialing);
    });
  });
}

const isRefused = (error: unknown) =>
  (error as { code?: string } | null)?.code === "ECONNREFUSED";

// Connects to a port on this machine's loopback: 127.0.0.1, and on an
// instant refusal there, ::1. Dev servers that bind `localhost` on a
// modern node land on ::1 alone, so a v4-only dial reports them as down
// and a forward to them fails on arrival. Only a refusal falls through:
// a timed-out v4 dial is the deadline spent, not a reason to spend it
// again. Loopback only, always: neither address can reach past the
// machine.
export async function dialLoopback(
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  try {
    return await dialOnce("127.0.0.1", port, timeoutMs);
  } catch (error) {
    if (!isRefused(error)) throw error;
    return dialOnce("::1", port, timeoutMs);
  }
}

// Is anything accepting connections on this port of the loopback? A
// dial that is closed the instant it connects. Any failure (refused,
// timed out, exotic) reads as "not listening": the probe informs a
// status dot, it never decides anything.
export async function isLoopbackPortListening(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const socket = await dialLoopback(port, timeoutMs);
    // A clean FIN, so the server does not log the probe as a reset. The
    // server may reset first (many close on FIN), so the error needs a
    // listener, and a server that never answers the FIN would hold the
    // socket open, so a deadline destroys it. Neither keeps the process
    // alive.
    socket.on("error", () => {});
    socket.setTimeout(timeoutMs, () => socket.destroy());
    socket.unref();
    socket.resume();
    socket.end();
    return true;
  } catch {
    return false;
  }
}
