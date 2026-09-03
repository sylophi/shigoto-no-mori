// The browser hub connection (v2 step 5a): the shared lifecycle core
// in shared/hub/connection.ts bound to the browser WebSocket global
// (no node ws), so it runs in a plain browser and, under node 22 (which
// ships a global WebSocket client), in the headless web:hub:check.
//
// A web client is a refuse-all host: it supplies the broker CHANNEL
// (the client role's req frames need it) but no handler, so the link's
// host role is empty by construction and answers every req with the
// no-handler shape. It only DIALS peers as a client (the direct
// dialer's broker leg), which is why this exposes just the client
// surface (connectBroker) plus the lifecycle (refresh, stop, status),
// not the broker slot the node connection carries.
//
// This file must stay electron-free and node-builtin-free (host:check):
// everything platform specific arrives through browser globals or the
// injected HubConnectOpts (deviceId, appVersion, accountId, the
// credential-backed ticket mint) and options (the broker channel, so
// no contract import lands here).
import { type HubBrokerSession, HubLinkDownError } from "@shared/hub/link";
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
  // The one channel the hub wire brokers, supplied by the
  // composition (the web bridge derives it from the direct contract)
  // so this binding stays contract-free like the node one.
  brokerChannel: string;
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its views.
  onChange?: () => void;
  // Test seams for the liveness heartbeat (shared/hub/connection.ts).
  heartbeat?: HeartbeatOptions;
};

export type HubConnectionBinding = {
  // The CLIENT half. Rejects with HubLinkDownError while the socket is
  // down.
  connectBroker(deviceId: string): Promise<HubBrokerSession>;
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
  // Channel only, no handler: a web client serves nobody, so the core
  // keeps the host role empty by construction and only the client role
  // (connectBroker) does any work.
  const core = createHubConnectionCore({
    openSocket: openBrowserSocket,
    onChange: opts.onChange,
    heartbeat: opts.heartbeat,
    broker: { channel: opts.brokerChannel },
  });
  return {
    connectBroker: core.connectBroker,
    refresh: core.refresh,
    stop: core.stop,
    status: core.status,
    probe: core.probe,
  };
}
