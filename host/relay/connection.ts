// The node relay connection (v2 step 4, slice C): the shared lifecycle
// core in shared/relay/connection.ts bound to the node `ws` client,
// owned by the main process and shared by both roles through the relay
// link. Mirrors the WsServerBinding shape (refresh/stop/status plus a
// ServerTransport half), so main/ipc/register.ts wires it the same way
// it wires the LAN listener.
//
// This file must stay Electron free (host:check). Everything Electron
// or account flavored (deviceId, appVersion, accountId, the
// credential-backed ticket mint) arrives through RelayConnectOpts, which
// main composes.
import { WebSocket } from "ws";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import {
  type ConnectPeerOpts,
  type PeerConnection,
  RelayLinkDownError,
} from "@shared/relay/link";
import { MAX_RELAY_MESSAGE_BYTES } from "@shared/relay/protocol";
import {
  createRelayConnectionCore,
  type RelaySocketAdapter,
} from "@shared/relay/connection";
import type {
  RelayConnectOpts,
  RelayConnectionStatus,
} from "@shared/relay/connectionTypes";
import { toText } from "@host/socket/rawData";

// Re-exported so existing importers keep resolving the option and status
// shapes from this module while the one definition lives in shared/ for
// the browser connection to share.
export type { RelayConnectOpts, RelayConnectionStatus };

export type RelayConnectionCallbacks = {
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its windows.
  onChange?: () => void;
  // Every push frame received from any peer, see RelayLinkDeps.
  onPeerPush?: (deviceId: string, channel: string, payload: unknown) => void;
  // Whether the named peer may run MUTATING calls on this host. Injected
  // from main, which reads the host's per-account grant store live, so a
  // grant or revoke takes effect without a relay reconnect. Left out (a
  // headless test, or a build with no grant model) means no peer may
  // command this host, so every mutating call is refused.
  isCommandGranted?: (peerDeviceId: string) => boolean;
};

export type RelayConnectionBinding = {
  // The HOST half. Registration is decoupled from connecting, exactly
  // like the LAN binding: handlers recorded at boot are served whenever
  // a socket is up.
  server: ServerTransport;
  // The CLIENT half. Rejects with RelayLinkDownError while the socket
  // is down.
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

// The node ws half of the shared socket adapter. Everything ws-specific
// lives here: the inbound payload bound, the disabled compression, the
// RawData decode, and the hard terminate the shared core prefers for
// orphan sockets and arms after an owner close.
function openWsSocket(url: string): RelaySocketAdapter {
  // Bound inbound buffering to the relay's own message limit,
  // mirroring the LAN listener's maxPayload, and disable
  // perMessageDeflate so a compression bomb cannot inflate a tiny
  // frame past the limit (S2).
  const socket = new WebSocket(url, {
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  socket.on("error", () => {
    // ws follows every error with close. The close handler owns the
    // outcome so the reject reason carries the close code.
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
    terminate() {
      try {
        socket.terminate();
      } catch {
        // Already gone.
      }
    },
    bufferedAmount: () => socket.bufferedAmount,
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

export function createRelayConnection(
  callbacks: RelayConnectionCallbacks = {},
): RelayConnectionBinding {
  // Shared by reference with every link generation, so handlers
  // registered at boot survive reconnects.
  const handlers = new Map<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >();
  // The EXPLICITLY read-only channel names (each handle's opts carried
  // mutating:false), shared by reference with every link generation.
  // Collected fail-closed: the link serves a channel to an ungranted peer
  // only when it is in this set, so a mutation or an untagged channel is
  // gated on a command grant. Populated at boot exactly like handlers,
  // before any socket exists.
  const readOnlyChannels = new Set<string>();
  const core = createRelayConnectionCore({
    openSocket: openWsSocket,
    onChange: callbacks.onChange,
    onPeerPush: callbacks.onPeerPush,
    handlers,
    readOnlyChannels,
    // The grant predicate the link consults live at dispatch. Defaults
    // to refusing every peer when main injects nothing, so a mutating
    // call is never served ungated by accident.
    isCommandGranted: callbacks.isCommandGranted ?? (() => false),
  });

  const server: ServerTransport = {
    handle(channel, fn, opts) {
      // Mirrors ipcMain.handle's one-handler-per-channel rule, so a
      // double registration fails at boot on every wire alike.
      if (handlers.has(channel)) {
        throw new Error(
          `[relay] handler already registered for channel "${channel}"`,
        );
      }
      handlers.set(channel, fn);
      // Record an EXPLICITLY read-only channel (mutating:false) so the
      // link may serve it to any account peer. Fail-closed: a channel
      // left untagged, or tagged mutating:true, is deliberately NOT
      // recorded here, so the link gates it on a per-peer command grant.
      if (opts?.mutating === false) readOnlyChannels.add(channel);
    },
    broadcastAll(channel, payload) {
      core.broadcastAll(channel, payload);
    },
  };

  return {
    server,
    connectPeer: core.connectPeer,
    refresh: core.refresh,
    stop: core.stop,
    status: core.status,
  };
}
