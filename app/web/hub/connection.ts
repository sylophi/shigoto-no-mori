// The browser hub connection: the shared lifecycle core
// in shared/hub/connection.ts bound to the browser WebSocket global
// (no node ws), so it runs in a plain browser and, under node 22 (which
// ships a global WebSocket client), in the headless web-hub test.
//
// A web client runs no direct listener, so it supplies no connectInfo
// server and its link refuses every peer's ask as serving no listener
// (a verdict the asking dialer parks on). It only ASKS, for the direct
// dialer, which is why this exposes just askConnectInfo plus the
// lifecycle (refresh, stop, status).
//
// This file must stay electron-free and node-builtin-free (pnpm test
// host-boundary): everything platform specific arrives through browser
// globals or the injected HubConnectOpts (deviceId, accountId, the
// credential-backed ticket mint).
import { HubLinkDownError } from "@shared/hub/link";
import {
  createHubConnectionCore,
  type HubSocketAdapter,
} from "@shared/hub/connection";
import type { HeartbeatOptions } from "@shared/ipc/socket/heartbeat";
import type {
  HubConnectOpts,
  HubConnectionStatus,
} from "@shared/hub/connectionTypes";

export type HubConnectionOpts = {
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its views.
  onChange?: () => void;
  // Test seams for the liveness heartbeat (shared/hub/connection.ts).
  heartbeat?: HeartbeatOptions;
};

export type HubConnectionBinding = {
  // Asks a peer for its connect info (HubLink.askConnectInfo). Rejects
  // with HubLinkDownError while the socket is down.
  askConnectInfo(
    deviceId: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<unknown>;
  // Reconciles the connection with the wanted state. The resolver runs
  // INSIDE the serialized lifecycle, and null means stop (signed out or
  // unconfigured).
  refresh(resolve: () => Promise<HubConnectOpts | null>): Promise<void>;
  stop(): Promise<void>;
  status(): HubConnectionStatus;
  // The wake-time liveness probe (shared/hub/connection.ts).
  probe(): void;
};

// The browser-global half of the shared socket adapter. A browser
// WebSocket has no terminate, no payload bound and no compression knob,
// so the adapter exposes only the advisory close and the shared core
// falls back to it wherever the node adapter would hard-terminate.
function openBrowserSocket(url: string): HubSocketAdapter {
  const socket = new WebSocket(url);
  socket.addEventListener("error", () => {
    // The browser fires error with no useful detail and always follows
    // it with close. The close handler owns the outcome so the reject
    // reason carries the close code.
  });
  return {
    send(text) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new HubLinkDownError();
      }
      socket.send(text);
    },
    close() {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
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

export function createHubConnection(
  opts: HubConnectionOpts,
): HubConnectionBinding {
  return createHubConnectionCore({
    openSocket: openBrowserSocket,
    onChange: opts.onChange,
    heartbeat: opts.heartbeat,
  });
}
