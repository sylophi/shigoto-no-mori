// The browser relay socket lifecycle (v2 step 5a): one outbound
// websocket from a web client to its account's Durable Object, driving
// the shared relay link. It mirrors the SHAPE of the node connection in
// host/relay/connection.ts but is built on browser globals only (the
// WebSocket global, no node ws), so it runs in a plain browser and, under
// node 22 (which ships a global WebSocket client), in the headless
// web:relay:check.
//
// A web client is a refuse-all host: it registers no handlers, exposes no
// read-only channels, and grants no peer, so it can never serve a command
// to a peer. It only DIALS peers as a client. That makes the host role a
// no-op here, so this exposes just the client surface (connectPeer) plus
// the lifecycle (refresh, stop, status), not the ServerTransport half the
// node connection carries.
//
// This file must stay electron-free and node-builtin-free (host:check):
// everything platform specific arrives through browser globals or the
// injected RelayConnectOpts (deviceId, appVersion, accountId, the
// credential-backed ticket mint).
import { errorMessageOf } from "@shared/errors";
import { HELLO_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import {
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  type ConnectPeerOpts,
  createRelayLink,
  type PeerConnection,
  RelayLinkDownError,
  type RelayLink,
} from "@shared/relay/link";
import type {
  RelayConnectOpts,
  RelayConnectionStatus,
} from "@shared/relay/connectionTypes";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  CONNECT_TICKET_PARAM,
  RELAY_ROUTES,
} from "@shared/relay/protocol";
import {
  type CloseClassifier,
  type ConnectFn,
  createSupervisor,
  type Supervisor,
  type SupervisorStatus,
} from "@shared/remote/supervisor";
import { createLimiter } from "@shared/util/limit";

export type { RelayConnectOpts, RelayConnectionStatus };

// The deadline for one dial phase: the ticket mint, and separately the
// ws accept (the first presence envelope). One honest value, the relay's
// HELLO_TIMEOUT_MS.
const ACCEPT_TIMEOUT_MS = HELLO_TIMEOUT_MS;

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

// The block-vs-retry rule for relay close codes, identical to the node
// connection. DEVICE_REVOKED is terminal until re-login. SUPERSEDED means
// another socket for this deviceId took over, and the losing side must
// not fight it. Everything else retries, since a fresh ticket is minted
// per attempt anyway.
const relayCloseClassifier: CloseClassifier = (code) => {
  if (code === CLOSE_DEVICE_REVOKED) {
    return { message: "this device was revoked, sign in again" };
  }
  if (code === CLOSE_SUPERSEDED) {
    return {
      message: "another instance of this device took over the relay",
    };
  }
  return null;
};

// The connect URL: ws(s) scheme, the shared connect route, the ticket in
// the query string.
function connectUrlFor(relayUrl: string, ticket: string): string {
  const base = relayUrl.endsWith("/") ? relayUrl.slice(0, -1) : relayUrl;
  const wsBase = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const param = `${CONNECT_TICKET_PARAM}=${encodeURIComponent(ticket)}`;
  return `${wsBase}${RELAY_ROUTES.connect.path}?${param}`;
}

// A web client grants no peer: it can never serve a mutating command, so
// its host-role grant predicate refuses every peer unconditionally.
function refuseAllCommands(): boolean {
  return false;
}

function sameOpts(a: RelayConnectOpts, b: RelayConnectOpts): boolean {
  // mintTicket is a closure and deliberately not compared: it reads the
  // stored credential fresh on every attempt.
  return (
    a.relayUrl === b.relayUrl &&
    a.accountId === b.accountId &&
    a.deviceId === b.deviceId &&
    a.appVersion === b.appVersion
  );
}

export function createRelayConnection(
  callbacks: RelayConnectionCallbacks = {},
): RelayConnectionBinding {
  // A web client serves nobody: it registers no handlers, tags no channel
  // read-only, and grants no peer. These stay empty by construction, so
  // the link's host role can never serve a command, and only the client
  // role (connectPeer) does any work.
  const handlers = new Map<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >();
  const readOnlyChannels = new Set<string>();
  let link: RelayLink | null = null;
  let current: { supervisor: Supervisor; opts: RelayConnectOpts } | null = null;
  let socketStatus: SupervisorStatus = { phase: "idle" };
  // The in-flight dial's cancel handle, so stop() can abort a dial that
  // has not yet established (the mint fetch or a half-open ws), not only
  // an established socket.
  let pendingDialAbort: AbortController | null = null;
  // Serializes refresh/stop so a fast account double-toggle cannot
  // interleave one refresh's stop with another's start.
  const lifecycle = createLimiter(1);

  function notifyChange(): void {
    callbacks.onChange?.();
  }

  // One connect attempt: mint a fresh ticket, dial the DO, and treat the
  // FIRST PRESENCE envelope as the accept signal (the DO sends it right
  // after accepting, and a rejected ticket never gets one, only a close).
  // The resolved DeviceConnection satisfies the supervisor's shape, with
  // empty remote identity because the DO speaks no sm welcome.
  function dial(
    opts: RelayConnectOpts,
    onClose: (code: number | null) => void,
  ): Promise<DeviceConnection> {
    return new Promise((resolve, reject) => {
      const dialAbort = new AbortController();
      pendingDialAbort = dialAbort;
      // One settle per dial: whichever of accept, timeout, close, mint
      // failure or stop lands first owns the outcome, and no later event
      // can flip established or fire a second onClose.
      let settled = false;
      let established = false;
      let ownerClosed = false;
      let ws: WebSocket | null = null;

      function clearPending(): void {
        if (pendingDialAbort === dialAbort) pendingDialAbort = null;
      }

      // stop() aborts this. A browser WebSocket has only close() (no
      // terminate), so a half-open ws is closed so an orphan dial cannot
      // complete after stop and get superseded into terminal blocked.
      dialAbort.signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        clearPending();
        if (ws !== null) {
          try {
            ws.close();
          } catch {
            // Already gone.
          }
        }
        reject(new RemoteConnectError("relay dial cancelled", null, false));
      });

      // The mint has its own deadline so a black-holed route cannot strand
      // the supervisor in "connecting" forever. It shares dialAbort so
      // stop() cancels the fetch too.
      const mintTimer = setTimeout(() => dialAbort.abort(), ACCEPT_TIMEOUT_MS);
      void opts
        .mintTicket(dialAbort.signal)
        .then((ticket) => {
          clearTimeout(mintTimer);
          if (settled) return;
          startDial(ticket);
        })
        .catch((error: unknown) => {
          clearTimeout(mintTimer);
          if (settled) return;
          settled = true;
          clearPending();
          // A failed mint (offline, relay down, signed out mid-flight,
          // timeout) is a retryable connect failure.
          reject(
            new RemoteConnectError(
              `ticket mint failed: ${errorMessageOf(error)}`,
              null,
              false,
            ),
          );
        });

      function startDial(ticket: string): void {
        const socket = new WebSocket(connectUrlFor(opts.relayUrl, ticket));
        ws = socket;
        // Set true once stop() or a rejection lands, so no further inbound
        // frame runs a handler even while the socket drains.
        let dead = false;

        const acceptTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearPending();
          try {
            socket.close();
          } catch {
            // Already closing.
          }
          reject(new RemoteConnectError("relay accept timeout", null, false));
        }, ACCEPT_TIMEOUT_MS);

        const nextLink = createRelayLink({
          localDeviceId: opts.deviceId,
          localAppVersion: opts.appVersion,
          send: (text) => {
            if (socket.readyState !== WebSocket.OPEN) {
              throw new RelayLinkDownError();
            }
            socket.send(text);
          },
          bufferedAmount: () => socket.bufferedAmount,
          // Empty by construction: a web client serves no peer.
          handlers,
          readOnlyChannels,
          isCommandGranted: refuseAllCommands,
          onPresence: () => {
            if (!settled) {
              settled = true;
              established = true;
              clearTimeout(acceptTimer);
              clearPending();
              link = nextLink;
              resolve({
                transport: {
                  // The relay socket carries no direct sm transport of its
                  // own. Peer traffic goes through connectPeer, so this
                  // seam only satisfies the shared DeviceConnection shape.
                  invoke: () =>
                    Promise.reject(
                      new Error(
                        "the relay socket has no direct transport, use connectPeer",
                      ),
                    ),
                  subscribe: () => () => {},
                },
                close: () => {
                  ownerClosed = true;
                  dead = true;
                  // Tear the link down synchronously so peer sessions abort
                  // at once, rather than waiting on the close event.
                  if (link === nextLink) link = null;
                  nextLink.teardown();
                  try {
                    socket.close();
                  } catch {
                    // Already closing.
                  }
                },
                remoteDeviceId: "",
                remoteAppVersion: "",
              });
            }
            notifyChange();
          },
          onPeerPush: callbacks.onPeerPush,
        });

        socket.addEventListener("message", (event: MessageEvent) => {
          // Once dead (owner close or a rejection), no further inbound
          // frame runs a handler even though the socket may still deliver
          // buffered frames while closing.
          if (dead) return;
          // The protocol is JSON text. A binary frame is not part of it,
          // so it is dropped rather than treated as fatal.
          if (typeof event.data !== "string") return;
          // Wrap so a throw cannot escape into the event dispatch and
          // become an uncaught exception.
          try {
            nextLink.handleMessage(event.data);
          } catch (error) {
            console.warn(
              `[relay] inbound message handler threw: ${errorMessageOf(error)}`,
            );
          }
        });
        socket.addEventListener("error", () => {
          // The browser fires error with no useful detail and always
          // follows it with close. The close handler owns the outcome so
          // the reject reason carries the close code.
        });
        socket.addEventListener("close", (event: CloseEvent) => {
          dead = true;
          clearTimeout(acceptTimer);
          clearPending();
          if (link === nextLink) link = null;
          nextLink.teardown();
          if (!settled) {
            settled = true;
            reject(
              new RemoteConnectError(
                `relay closed before accept (code ${event.code})`,
                event.code,
                relayCloseClassifier(event.code) !== null,
              ),
            );
            notifyChange();
            return;
          }
          // An established socket dropped. The owner-close path stays
          // silent so the supervisor never reconnects against its own
          // stop.
          if (established && !ownerClosed) onClose(event.code);
          notifyChange();
        });
      }
    });
  }

  function stopNow(): void {
    if (current === null) return;
    const { supervisor } = current;
    current = null;
    // Cancel any in-flight dial (mint fetch or half-open ws) so an orphan
    // connect cannot complete after stop and be superseded into terminal
    // blocked.
    if (pendingDialAbort !== null) {
      pendingDialAbort.abort();
      pendingDialAbort = null;
    }
    // stop() closes the live socket via the connection's close, whose
    // close event tears the link down (the owner close also tears it down
    // synchronously).
    supervisor.stop();
  }

  function startNow(opts: RelayConnectOpts): void {
    const connect: ConnectFn = (connectOpts) => dial(opts, connectOpts.onClose);
    const supervisor = createSupervisor({
      // The params satisfy the supervisor's LAN-oriented shape. Only url
      // is meaningful here, and the token is empty by design.
      params: {
        url: opts.relayUrl,
        token: "",
        appVersion: opts.appVersion,
        localDeviceId: opts.deviceId,
      },
      connect,
      classifyClose: relayCloseClassifier,
      onStatus: (next) => {
        socketStatus = next;
        notifyChange();
      },
    });
    current = { supervisor, opts };
    supervisor.start();
  }

  return {
    connectPeer(deviceId, opts) {
      if (link === null) {
        return Promise.reject(new RelayLinkDownError());
      }
      return link.connectPeer(deviceId, opts);
    },

    refresh: (resolve) =>
      lifecycle(async () => {
        const opts = await resolve();
        if (opts === null) {
          stopNow();
          return;
        }
        // A blocked supervisor restarts on refresh: refresh only runs when
        // inputs may have changed (boot, sign-in, sign-out), and blocked
        // is terminal precisely until then.
        if (
          current !== null &&
          sameOpts(current.opts, opts) &&
          socketStatus.phase !== "blocked"
        ) {
          return;
        }
        stopNow();
        startNow(opts);
      }),

    stop: () =>
      lifecycle(async () => {
        stopNow();
      }),

    status: () => {
      const localDeviceId = current?.opts.deviceId;
      // The link owns the authoritative roster and per-peer versions, so
      // this reads them rather than keeping a second copy that a stale
      // generation's close could wipe. Presence includes the receiver per
      // protocol.ts, so the local device is filtered out.
      const online = (link?.onlineDeviceIds() ?? []).filter(
        (id) => id !== localDeviceId,
      );
      return {
        socket: socketStatus,
        onlineDeviceIds: online,
        peerAppVersions: link?.peerAppVersions() ?? {},
      };
    },
  };
}
