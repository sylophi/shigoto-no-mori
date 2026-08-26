// Socket plumbing shared by the port-forward wire's two halves: the
// host verbs (host/ipc/modules/forward.ts) and the client engine
// (main/portForward/engine.ts).
import type { Socket } from "node:net";

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
