// The node hub connection (v2 step 4, slice C): the shared lifecycle
// core in shared/hub/connection.ts bound to the node `ws` client,
// owned by the main process and shared by both roles through the hub
// link. Deliberately NOT a ServerTransport (v2 step 10, slice C): the
// wire serves exactly one channel, so the binding exposes a single
// broker slot instead of handle/broadcastAll, and re-adding the hub
// to a wire loop that expects a ServerTransport is a type error rather
// than a discouraged one-liner.
//
// This file must stay Electron free (host:check). Everything Electron
// or account flavored (deviceId, appVersion, accountId, the
// credential-backed ticket mint) arrives through HubConnectOpts, which
// main composes.
import { WebSocket } from "ws";
import {
  type HubBroker,
  type HubBrokerSession,
  HubLinkDownError,
} from "@shared/hub/link";
import {
  createHubConnectionCore,
  type HubSocketAdapter,
} from "@shared/hub/connection";
import type {
  HubConnectOpts,
  HubConnectionStatus,
} from "@shared/hub/connectionTypes";
import { toText } from "@host/socket/rawData";

export type HubConnectionOpts = {
  // The one channel the hub wire brokers, supplied by the
  // composition at creation (register.ts derives it from the direct
  // contract) so this binding stays contract-free. Static config on
  // purpose, separate from the late-bound handler registration: the
  // CLIENT role needs the channel to frame its broker reqs even on a
  // connection that never registers a handler (the check fixtures'
  // dial-only devices).
  brokerChannel: string;
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its windows.
  onChange?: () => void;
};

export type HubConnectionBinding = {
  // The HOST half: the ONE broker slot this wire serves, as the
  // channel-plus-handler pair the composition supplies (so this
  // binding never imports a contract). Registration is decoupled from
  // connecting, exactly like the LAN binding: the pair recorded at
  // boot is served whenever a socket is up. Throws on a second
  // registration (mirroring ipcMain.handle's one-handler-per-channel
  // rule) and on a pair naming a different channel than the one this
  // connection was created with, so a composition wiring two contracts
  // together fails at boot instead of serving a channel it never
  // dials.
  registerBroker(broker: Required<HubBroker>): void;
  // The CLIENT half. Rejects with HubLinkDownError while the socket
  // is down.
  connectBroker(deviceId: string): Promise<HubBrokerSession>;
  // Reconciles the connection with the wanted state. The resolver runs
  // INSIDE the serialized lifecycle, and null means stop (signed out or
  // unconfigured).
  refresh(resolve: () => Promise<HubConnectOpts | null>): Promise<void>;
  stop(): Promise<void>;
  status(): HubConnectionStatus;
};

// Deploy-skew tolerance for the INBOUND payload bound: the sender-side
// guard and the DO's forwarding budget both enforce
// MAX_HUB_MESSAGE_BYTES (64 KiB), but an old, not-yet-redeployed
// Worker still forwards up to the previous 1 MiB cap from an old peer,
// and one oversize inbound frame past ws's maxPayload kills the WHOLE
// control-plane socket (close 1009) in a reconnect loop. So the reader
// stays tolerant at the old bound while every writer is strict. This
// can shrink to MAX_HUB_MESSAGE_BYTES once every Worker and device
// in the fleet enforces the 64 KiB cap (see hub/README.md's deploy
// order note).
const INBOUND_MAX_PAYLOAD_BYTES = 1024 * 1024;

// The node ws half of the shared socket adapter. Everything ws-specific
// lives here: the inbound payload bound, the disabled compression, the
// RawData decode, and the hard terminate the shared core prefers for
// orphan sockets and arms after an owner close.
function openWsSocket(url: string): HubSocketAdapter {
  // Bound inbound buffering (tolerantly, see above), and disable
  // perMessageDeflate so a compression bomb cannot inflate a tiny
  // frame past the limit (S2).
  const socket = new WebSocket(url, {
    maxPayload: INBOUND_MAX_PAYLOAD_BYTES,
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
  // The late-bound handler slot: registered at boot, read through a
  // stable closure by every link generation, so the registration
  // survives reconnects. The channel is creation-time config instead
  // (the client role dials it with no handler registered), so only the
  // handler arm needs the not-registered refusal, unreachable in
  // practice on a serving device (boot registers before refresh ever
  // connects).
  let broker: Required<HubBroker> | null = null;
  const core = createHubConnectionCore({
    openSocket: openWsSocket,
    onChange: opts.onChange,
    broker: {
      channel: opts.brokerChannel,
      handler: (ctx, raw) => {
        if (broker === null) {
          return Promise.reject(new Error("[hub] broker not registered"));
        }
        return broker.handler(ctx, raw);
      },
    },
  });

  return {
    registerBroker(pair) {
      // Mirrors ipcMain.handle's one-handler-per-channel rule, so a
      // double registration fails at boot on every wire alike.
      if (broker !== null) {
        throw new Error("[hub] broker handler already registered");
      }
      // The pair's channel must be the one this connection dials and
      // serves, or the composition wired two different contracts.
      if (pair.channel !== opts.brokerChannel) {
        throw new Error(
          `[hub] broker channel mismatch: registered "${pair.channel}", connection carries "${opts.brokerChannel}"`,
        );
      }
      broker = pair;
    },
    connectBroker: core.connectBroker,
    refresh: core.refresh,
    stop: core.stop,
    status: core.status,
  };
}
