// The browser hub connection: the shared lifecycle core
// in shared/hub/connection.ts bound to the browser WebSocket global
// (no node ws), so it runs in a plain browser.
//
// A web client runs no direct listener, so it supplies no connectInfo
// server and its link refuses every peer's ask as serving no listener
// (a verdict the asking dialer parks on).
//
// This file must stay electron-free and node-builtin-free: everything
// platform specific arrives through browser globals or the injected
// HubConnectOpts (deviceId, accountId, the credential-backed ticket
// mint).
import { HubLinkDownError } from "@shared/hub/link";
import * as Shared from "@shared/hub/connection";

// The browser-global half of the shared socket adapter. A browser
// WebSocket has no terminate, no payload bound and no compression knob,
// so the adapter exposes only the advisory close and the shared core
// falls back to it wherever the node adapter would hard-terminate.
function openBrowserSocket(url: string): Shared.HubSocketAdapter {
  // An error event carries nothing and a close always follows it, so
  // the close handler owns the outcome, with its code.
  const socket = new WebSocket(url);
  return {
    send(text) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new HubLinkDownError();
      }
      socket.send(text);
    },
    close() {
      socket.close();
    },
    onMessage(handler) {
      socket.addEventListener("message", (event: MessageEvent) => {
        // The protocol is JSON text. A binary frame is not part of it,
        // so it is dropped rather than treated as fatal.
        if (typeof event.data !== "string") return;
        handler(event.data);
      });
    },
    onClose(handler) {
      socket.addEventListener("close", (event: CloseEvent) =>
        handler(event.code),
      );
    },
  };
}

// The connection, for the length of the scope it is made in.
export const make = (opts: Omit<Shared.HubConnectionDeps, "openSocket">) =>
  Shared.make({ ...opts, openSocket: openBrowserSocket });
