// A MessagePort as the WebSocket surface Effect's Socket reads
// (Socket.fromWebSocket), so Effect RPC runs over a port exactly as it
// runs over the device link's socket: the desktop window's calls to the
// shell (main/ipc/shellLink.ts) ride one. The two ends hand over
// different ports, the DOM's in the window and Electron's MessagePortMain
// in the shell, so each passes how to listen to its own.
import type * as Socket from "effect/socket/Socket";

type Listener = (event: Socket.WebSocketEvent) => void;

export type PortEnds = {
  readonly postMessage: (data: Uint8Array) => void;
  readonly close: () => void;
  // Starts delivery, handing every message's data to `onMessage` and the
  // port closing (the other end gone) to `onClose`.
  readonly listen: (
    onMessage: (data: unknown) => void,
    onClose: () => void,
  ) => void;
};

export function portSocket(port: PortEnds): Socket.WebSocketLike {
  const listeners = {
    open: new Set<Listener>(),
    message: new Set<Listener>(),
    error: new Set<Listener>(),
    close: new Set<Listener>(),
  };
  // A listener added `once` is removed by the one it was added as.
  const onceOf = new Map<Listener, Listener>();
  let readyState = 1;
  const emit = (type: keyof typeof listeners, event: Socket.WebSocketEvent) => {
    for (const listener of listeners[type]) listener(event);
  };
  const closed = () => {
    if (readyState === 3) return;
    readyState = 3;
    emit("close", { code: 1000 });
  };
  port.listen((data) => emit("message", { data }), closed);
  return {
    get readyState() {
      return readyState;
    },
    addEventListener(type, listener, options) {
      if (options?.once !== true) {
        listeners[type].add(listener);
        return;
      }
      const once: Listener = (event) => {
        listeners[type].delete(once);
        onceOf.delete(listener);
        listener(event);
      };
      onceOf.set(listener, once);
      listeners[type].add(once);
    },
    removeEventListener(type, listener) {
      listeners[type].delete(onceOf.get(listener) ?? listener);
      onceOf.delete(listener);
    },
    send(data) {
      if (readyState !== 1) throw new Error("the port is closed");
      port.postMessage(
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      );
    },
    close() {
      if (readyState === 3) return;
      port.close();
      closed();
    },
  };
}
