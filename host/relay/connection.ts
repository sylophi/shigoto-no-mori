// The relay socket lifecycle (v2 step 4, slice C): one outbound
// websocket from this device to its account's Durable Object, owned by
// the main process and shared by both roles through the relay link.
// Mirrors the WsServerBinding shape (refresh/stop/status plus a
// ServerTransport half), so main/ipc/register.ts wires it the same way
// it wires the LAN listener.
//
// This file must stay Electron free (host:check). Everything Electron
// or account flavored (deviceId, appVersion, accountId, the
// credential-backed ticket mint) arrives through RelayConnectOpts, which
// main composes.
import { type RawData, WebSocket } from "ws";
import { errorMessageOf } from "@shared/errors";
import { HELLO_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import {
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import {
  createRelayLink,
  RelayLinkDownError,
  type ConnectPeerOpts,
  type PeerConnection,
  type RelayLink,
} from "@shared/relay/link";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  CONNECT_TICKET_PARAM,
  MAX_RELAY_MESSAGE_BYTES,
  RELAY_ROUTES,
} from "@shared/relay/protocol";
import {
  type CloseClassifier,
  type ConnectFn,
  createSupervisor,
  type Supervisor,
  type SupervisorStatus,
} from "@shared/remote/supervisor";
import { createLimiter } from "@host/lib/util/limit";

// The deadline for one dial phase: the ticket mint, and separately the
// ws accept (the first presence envelope). Named rather than a bare knob
// because the relay has one honest value here, HELLO_TIMEOUT_MS.
const ACCEPT_TIMEOUT_MS = HELLO_TIMEOUT_MS;
// After an owner close, how long a stalled relay has before its socket
// is terminated, so a compromised relay that stalls the close handshake
// cannot keep the socket (and its handlers) alive for ws's ~30s window.
const TERMINATE_GRACE_MS = 1_500;

export type RelayConnectOpts = {
  // Base URL of the relay Worker (http(s) or ws(s) scheme, converted
  // to ws(s) here).
  relayUrl: string;
  // The signed-in account this socket belongs to. In sameOpts so signing
  // into a DIFFERENT account (which rotates the credential) forces a
  // reconnect rather than leaving the old socket live on the old
  // account's DO (C7).
  accountId: string;
  // Mints one single-use connect ticket. Injected so this module never
  // touches the credential store: main composes it from the account
  // layer, and a fresh ticket is minted per connect attempt. The signal
  // aborts the mint on stop or on the mint timeout.
  mintTicket(signal: AbortSignal): Promise<string>;
  // This device's id and app version, the identity peers see in the sm
  // hello/welcome handshake. Electron facts, injected.
  deviceId: string;
  appVersion: string;
};

export type RelayConnectionStatus = {
  // The relay socket's supervisor phase. On the connected phase the
  // remote identity fields are empty: the DO has no sm welcome, its
  // accept signal is the first presence envelope.
  socket: SupervisorStatus;
  // The account's online deviceIds from the latest presence broadcast,
  // the local device filtered out, empty whenever the socket is down.
  onlineDeviceIds: string[];
  // The appVersion each currently connected client peer confirmed in its
  // welcome, so a status snapshot carries it and the renderer does not
  // poll per device.
  peerAppVersions: Record<string, string>;
};

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

// The block-vs-retry rule for relay close codes. DEVICE_REVOKED is
// terminal until re-login. SUPERSEDED means another socket for this
// deviceId took over, and the losing side must not fight it, so it
// blocks with a distinct message. TICKET_REJECTED and everything else
// retry normally, since a fresh ticket is minted per attempt anyway.
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

// The connect URL: ws(s) scheme, the shared connect route, the ticket
// in the query string.
function connectUrlFor(relayUrl: string, ticket: string): string {
  const base = relayUrl.endsWith("/") ? relayUrl.slice(0, -1) : relayUrl;
  const wsBase = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const param = `${CONNECT_TICKET_PARAM}=${encodeURIComponent(ticket)}`;
  return `${wsBase}${RELAY_ROUTES.connect.path}?${param}`;
}

function sameOpts(a: RelayConnectOpts, b: RelayConnectOpts): boolean {
  // mintTicket is a closure and deliberately not compared: it reads
  // the stored credential fresh on every attempt.
  return (
    a.relayUrl === b.relayUrl &&
    a.accountId === b.accountId &&
    a.deviceId === b.deviceId &&
    a.appVersion === b.appVersion
  );
}

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
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
  // The grant predicate the link consults live at dispatch. Defaults to
  // refusing every peer when main injects nothing, so a mutating call is
  // never served ungated by accident.
  const isCommandGranted = callbacks.isCommandGranted ?? (() => false);
  let link: RelayLink | null = null;
  let current: { supervisor: Supervisor; opts: RelayConnectOpts } | null = null;
  let socketStatus: SupervisorStatus = { phase: "idle" };
  // The in-flight dial's cancel handle, so stop() can abort a dial that
  // has not yet established (the mint fetch or a half-open ws), not only
  // an established socket (C2).
  let pendingDialAbort: AbortController | null = null;
  // Serializes refresh/stop so a fast account double-toggle cannot
  // interleave one refresh's stop with another's start.
  const lifecycle = createLimiter(1);

  function notifyChange(): void {
    callbacks.onChange?.();
  }

  // One connect attempt: mint a fresh ticket, dial the DO, and treat
  // the FIRST PRESENCE envelope as the accept signal (the DO sends it
  // right after accepting, and a rejected ticket never gets one, only
  // a close). The resolved DeviceConnection satisfies the supervisor's
  // shape, with empty remote identity because the DO speaks no sm
  // welcome.
  function dial(
    opts: RelayConnectOpts,
    onClose: (code: number | null) => void,
  ): Promise<DeviceConnection> {
    return new Promise((resolve, reject) => {
      const dialAbort = new AbortController();
      pendingDialAbort = dialAbort;
      // One settle per dial: whichever of accept, timeout, close, mint
      // failure or stop lands first owns the outcome, and no later event
      // can flip established or fire a second onClose (C5).
      let settled = false;
      let established = false;
      let ownerClosed = false;
      let ws: WebSocket | null = null;

      function clearPending(): void {
        if (pendingDialAbort === dialAbort) pendingDialAbort = null;
      }

      // stop() aborts this. Terminate a half-open ws so an orphan dial
      // cannot complete after stop and get superseded into terminal
      // blocked (C2).
      dialAbort.signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        clearPending();
        if (ws !== null) {
          try {
            ws.terminate();
          } catch {
            // Already gone.
          }
        }
        reject(new RemoteConnectError("relay dial cancelled", null, false));
      });

      // The mint has its own deadline so a black-holed route cannot
      // strand the supervisor in "connecting" forever (C6). It shares
      // dialAbort so stop() cancels the fetch too.
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
        // Bound inbound buffering to the relay's own message limit,
        // mirroring the LAN listener's maxPayload, and disable
        // perMessageDeflate so a compression bomb cannot inflate a tiny
        // frame past the limit (S2).
        const socket = new WebSocket(connectUrlFor(opts.relayUrl, ticket), {
          maxPayload: MAX_RELAY_MESSAGE_BYTES,
          perMessageDeflate: false,
        });
        ws = socket;
        // Set true once stop() or a rejection lands, so no further
        // inbound frame runs a handler even while ws drains (S3).
        let dead = false;

        const acceptTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearPending();
          try {
            socket.terminate();
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
          handlers,
          // Shared by reference (populated at boot). The link serves a
          // channel to an ungranted peer only when it is in this
          // read-only set, so a mutating call from a peer this host has
          // not granted is refused while reads pass through.
          // isCommandGranted is read live at dispatch so a grant takes
          // effect without a reconnect.
          readOnlyChannels,
          isCommandGranted,
          onPresence: () => {
            if (!settled) {
              settled = true;
              established = true;
              clearTimeout(acceptTimer);
              clearPending();
              link = nextLink;
              resolve({
                transport: {
                  // The relay socket carries no direct sm transport
                  // of its own. Peer traffic goes through connectPeer,
                  // so this seam only satisfies the shared
                  // DeviceConnection shape.
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
                  // Tear the link down SYNCHRONOUSLY so host sessions
                  // abort at once and no in-flight handler answers into a
                  // dead socket, rather than waiting on the close event
                  // (S3).
                  if (link === nextLink) link = null;
                  nextLink.teardown();
                  try {
                    socket.close();
                  } catch {
                    // Already closing.
                  }
                  // close() is advisory: a stalled relay can hold it for
                  // ~30s. Terminate after a short grace so it cannot.
                  setTimeout(() => {
                    try {
                      socket.terminate();
                    } catch {
                      // Already gone.
                    }
                  }, TERMINATE_GRACE_MS);
                },
                remoteDeviceId: "",
                remoteAppVersion: "",
              });
            }
            notifyChange();
          },
          onPeerPush: callbacks.onPeerPush,
        });

        socket.on("message", (data, isBinary) => {
          // Once dead (owner close or a rejection), no further inbound
          // frame runs a handler even though ws may still deliver
          // buffered frames while closing (S3).
          if (dead) return;
          // The protocol is JSON text. Binary frames are not part of
          // it, so they are dropped.
          if (isBinary) return;
          // Wrap so a throw cannot escape into the ws EventEmitter and
          // become an uncaught main-process exception (M4).
          try {
            nextLink.handleMessage(toText(data));
          } catch (error) {
            console.warn(
              `[relay] inbound message handler threw: ${errorMessageOf(error)}`,
            );
          }
        });
        socket.on("error", () => {
          // ws follows every error with close. The close handler owns
          // the outcome so the reject reason carries the close code.
        });
        socket.on("close", (code) => {
          dead = true;
          clearTimeout(acceptTimer);
          clearPending();
          if (link === nextLink) link = null;
          nextLink.teardown();
          if (!settled) {
            settled = true;
            reject(
              new RemoteConnectError(
                `relay closed before accept (code ${code})`,
                code,
                relayCloseClassifier(code) !== null,
              ),
            );
            notifyChange();
            return;
          }
          // An established socket dropped. The owner-close path stays
          // silent so the supervisor never reconnects against its own
          // stop.
          if (established && !ownerClosed) onClose(code);
          notifyChange();
        });
      }
    });
  }

  function stopNow(): void {
    if (current === null) return;
    const { supervisor } = current;
    current = null;
    // Cancel any in-flight dial (mint fetch or half-open ws) so an
    // orphan connect cannot complete after stop and be superseded into
    // terminal blocked (C2).
    if (pendingDialAbort !== null) {
      pendingDialAbort.abort();
      pendingDialAbort = null;
    }
    // stop() closes the live socket via the connection's close, whose
    // close event tears the link down (the owner close also tears it
    // down synchronously).
    supervisor.stop();
  }

  function startNow(opts: RelayConnectOpts): void {
    const connect: ConnectFn = (connectOpts) => dial(opts, connectOpts.onClose);
    const supervisor = createSupervisor({
      // The params satisfy the supervisor's LAN-oriented shape. Only
      // url is meaningful here, and the token is empty by design.
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
      // No socket or no helloed peers means nobody to tell, silently.
      link?.broadcastAll(channel, payload);
    },
  };

  return {
    server,

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
        // A blocked supervisor restarts on refresh: refresh only runs
        // when inputs may have changed (boot, sign-in, sign-out,
        // rename), and blocked is terminal precisely until then.
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
      // generation's close could wipe (C4). Presence includes the
      // receiver per protocol.ts, so the local device is filtered out.
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
