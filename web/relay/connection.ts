// The browser relay connection (v2 step 5a): the shared lifecycle core
// in shared/relay/connection.ts bound to the browser WebSocket global
// (no node ws), so it runs in a plain browser and, under node 22 (which
// ships a global WebSocket client), in the headless web:relay:check.
//
// A web client is a refuse-all host: it passes the core no handlers, no
// read-only channels and no grant predicate, so the link's host role is
// empty by construction and can never serve a command to a peer. It
// only DIALS peers as a client, which is why this exposes just the
// client surface (connectPeer) plus the lifecycle (refresh, stop,
// status), not the ServerTransport half the node connection carries.
//
// This file must stay electron-free and node-builtin-free (host:check):
// everything platform specific arrives through browser globals or the
// injected RelayConnectOpts (deviceId, appVersion, accountId, the
// credential-backed ticket mint).
import {
  type ConnectPeerOpts,
  type PeerConnection,
  RelayLinkDownError,
} from "@shared/relay/link";
import {
  createRelayConnectionCore,
  type RelaySocketAdapter,
} from "@shared/relay/connection";
import type {
  RelayConnectOpts,
  RelayConnectionStatus,
} from "@shared/relay/connectionTypes";

export type { RelayConnectOpts, RelayConnectionStatus };

export type RelayConnectionCallbacks = {
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its views.
  onChange?: () => void;
  // Every push frame received from any peer, see RelayLinkDeps.
  onPeerPush?: (deviceId: string, channel: string, payload: unknown) => void;
};

export type RelayConnectionBinding = {
  // The CLIENT half. Rejects with RelayLinkDownError while the socket is
  // down.
  connectPeer(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
  // Reconciles the connection with the wanted state. The resolver runs
  // INSIDE the serialized lifecycle, and null means stop (signed out or
  // unconfigured).
  refresh(resolve: () => Promise<RelayConnectOpts | null>): Promise<void>;
  stop(): Promise<void>;
  status(): RelayConnectionStatus;
};

// The browser-global half of the shared socket adapter. A browser
// WebSocket has no terminate, no payload bound and no compression knob,
// so the adapter exposes only the advisory close and the shared core
// falls back to it wherever the node adapter would hard-terminate.
function openBrowserSocket(url: string): RelaySocketAdapter {
  const socket = new WebSocket(url);
  socket.addEventListener("error", () => {
    // The browser fires error with no useful detail and always follows
    // it with close. The close handler owns the outcome so the reject
    // reason carries the close code.
  });
  return {
    send(text) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new RelayLinkDownError();
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
    bufferedAmount: () => socket.bufferedAmount,
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

export function createRelayConnection(
  callbacks: RelayConnectionCallbacks = {},
): RelayConnectionBinding {
  // No host-role deps: a web client serves nobody, so the core keeps
  // the host role empty by construction and only the client role
  // (connectPeer) does any work.
  const core = createRelayConnectionCore({
    openSocket: openBrowserSocket,
    onChange: callbacks.onChange,
    onPeerPush: callbacks.onPeerPush,
  });
  return {
    connectPeer: core.connectPeer,
    refresh: core.refresh,
    stop: core.stop,
    status: core.status,
  };
}
