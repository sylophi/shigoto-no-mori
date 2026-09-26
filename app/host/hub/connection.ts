// The node hub connection: the shared lifecycle
// core in shared/hub/connection.ts bound to the node `ws` client,
// owned by the main process, asking peers for their connect info and
// answering theirs. Deliberately NOT a ServerTransport: the wire
// answers one question, handed in at creation as a function, so
// re-adding the hub to a wire loop that expects a ServerTransport is a
// type error rather than a discouraged one-liner.
//
// This file must stay Electron free (pnpm test host-boundary).
// Everything Electron or account flavored (deviceId, accountId, the
// credential-backed ticket mint) arrives through HubConnectOpts, which
// main composes.
import { WebSocket } from "ws";
import { HubLinkDownError, type ServeConnectInfo } from "@shared/hub/link";
import {
  createHubConnectionCore,
  type HubSocketAdapter,
} from "@shared/hub/connection";
import type { HeartbeatOptions } from "@shared/ipc/socket/heartbeat";
import { MAX_HUB_MESSAGE_BYTES } from "@shared/hub/protocol";
import type {
  HubConnectOpts,
  HubConnectionStatus,
} from "@shared/hub/connectionTypes";
import { toText } from "@host/socket/rawData";

export type HubConnectionOpts = {
  // Answers peers' connectInfo asks (main/ipc/register.ts wires the
  // direct listener's). Absent on a dial-only device (the check
  // fixtures'), whose link refuses every ask as serving no listener.
  serveConnectInfo?: ServeConnectInfo;
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its windows.
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

// The node ws half of the shared socket adapter. Everything ws-specific
// lives here: the inbound payload bound, the disabled compression, the
// RawData decode, and the hard terminate the shared core prefers for
// orphan sockets and arms after an owner close.
function openWsSocket(url: string): HubSocketAdapter {
  // Bound inbound buffering at the DO's own forwarding limit (nothing
  // it sends is larger: relays are measured against it and a full
  // presence roster fits under it), and disable perMessageDeflate so a
  // compression bomb cannot inflate a tiny frame past the limit (S2).
  // An oversize frame past maxPayload closes the socket (1009), so
  // shrinking MAX_HUB_MESSAGE_BYTES means shipping devices that still
  // read the old size before the Worker enforces the new one
  // (hub/README.md).
  const socket = new WebSocket(url, {
    maxPayload: MAX_HUB_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  socket.on("error", () => {
    // ws follows every error with close. The close handler owns the
    // outcome so the reject reason carries the close code.
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
    terminate() {
      try {
        socket.terminate();
      } catch {
        // Already gone.
      }
    },
    onMessage(handler) {
      socket.on("message", (data, isBinary) => {
        // The protocol is JSON text. Binary frames are not part of
        // it, so they are dropped.
        if (isBinary) return;
        handler(toText(data));
      });
    },
    onClose(handler) {
      socket.on("close", (code) => handler(code));
    },
  };
}

export function createHubConnection(
  opts: HubConnectionOpts,
): HubConnectionBinding {
  return createHubConnectionCore({
    openSocket: openWsSocket,
    onChange: opts.onChange,
    heartbeat: opts.heartbeat,
    serveConnectInfo: opts.serveConnectInfo,
  });
}
