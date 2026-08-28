// The shared relay connection lifecycle: one outbound socket from this
// device to its account's Durable Object, driving the relay link. The
// node desktop connection (host/relay/connection.ts) and the browser
// connection (web/relay/connection.ts) were a near-verbatim fork of
// this machine and had already begun to drift, so the dial settle
// logic, the supervisor wiring and the refresh/stop/status lifecycle
// live here exactly once, behind a small socket adapter each platform
// implements over its own WebSocket.
//
// This file must stay electron-free and node-builtin-free (host:check):
// everything platform specific lives in the injected adapter, and
// everything account flavored (deviceId, appVersion, accountId, the
// credential-backed ticket mint) arrives through RelayConnectOpts.
import { errorMessageOf } from "@shared/errors";
import {
  HELLO_TIMEOUT_MS,
  TERMINATE_GRACE_MS,
} from "@shared/ipc/socket/frames";
import {
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import {
  createRelayLink,
  type RelayBroker,
  type RelayBrokerSession,
  type RelayLink,
  RelayLinkDownError,
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

// The deadline for one dial phase: the ticket mint, and separately the
// socket accept (the first presence envelope). Named rather than a bare
// knob because the relay has one honest value here, HELLO_TIMEOUT_MS.
const ACCEPT_TIMEOUT_MS = HELLO_TIMEOUT_MS;

// One dialed relay socket as the platform adapter exposes it to the
// core. The adapter owns the platform WebSocket and its event wiring,
// the core owns everything above it.
export type RelaySocketAdapter = {
  // Writes one text message. Throws when the socket is unusable (the
  // adapters throw RelayLinkDownError before the socket is open), and
  // the caller of the failed operation sees it.
  send(text: string): void;
  // Advisory close. The adapter swallows an already-closing socket, so
  // the core calls it unguarded.
  close(): void;
  // Hard cut, where the platform has one (node ws). The core prefers it
  // for orphan sockets and arms the post-close terminate grace only
  // when it exists. A browser socket has only close.
  terminate?(): void;
  // Delivers each inbound TEXT message. The adapter drops binary
  // frames: the protocol is JSON text, so they are not part of it.
  onMessage(handler: (text: string) => void): void;
  // Delivers the close code once the socket is gone. Platform error
  // events carry no useful detail and are always followed by close, so
  // the adapter swallows them and this is the one teardown signal.
  onClose(handler: (code: number) => void): void;
};

export type RelayConnectionCoreDeps = {
  openSocket(url: string): RelaySocketAdapter;
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its views.
  onChange?: () => void;
  // The channel-plus-handler pair the relay wire serves (see
  // RelayBroker in link.ts), supplied by the composition so this core
  // never imports a contract. The node binding passes a facade over
  // its late-bound slot so registration at boot survives link
  // recreation across reconnects. A client-only platform (the web)
  // supplies the channel with no handler, leaving the host role empty
  // by construction: the link then answers every req with the
  // no-handler shape.
  broker: RelayBroker;
};

// The lifecycle surface both platform bindings re-expose unchanged.
export type RelayConnectionCore = {
  connectBroker(deviceId: string): Promise<RelayBrokerSession>;
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

// Prefer the adapter's hard terminate for a socket nothing should keep
// draining (an aborted or timed-out dial), falling back to the advisory
// close where the platform has nothing harder.
function killSocket(socket: RelaySocketAdapter): void {
  if (socket.terminate !== undefined) socket.terminate();
  else socket.close();
}

export function createRelayConnectionCore(
  deps: RelayConnectionCoreDeps,
): RelayConnectionCore {
  let link: RelayLink | null = null;
  let current: { supervisor: Supervisor; opts: RelayConnectOpts } | null = null;
  let socketStatus: SupervisorStatus = { phase: "idle" };
  // The in-flight dial's cancel handle, so stop() can abort a dial that
  // has not yet established (the mint fetch or a half-open socket), not
  // only an established socket (C2).
  let pendingDialAbort: AbortController | null = null;
  // Serializes refresh/stop so a fast account double-toggle cannot
  // interleave one refresh's stop with another's start.
  const lifecycle = createLimiter(1);

  function notifyChange(): void {
    deps.onChange?.();
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
      let ws: RelaySocketAdapter | null = null;

      function clearPending(): void {
        if (pendingDialAbort === dialAbort) pendingDialAbort = null;
      }

      // stop() aborts this. Kill a half-open socket so an orphan dial
      // cannot complete after stop and get superseded into terminal
      // blocked (C2).
      dialAbort.signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        clearPending();
        if (ws !== null) killSocket(ws);
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
        const socket = deps.openSocket(connectUrlFor(opts.relayUrl, ticket));
        ws = socket;
        // Set true once stop() or a rejection lands, so no further
        // inbound frame runs a handler even while the socket drains (S3).
        let dead = false;

        const acceptTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearPending();
          killSocket(socket);
          reject(new RemoteConnectError("relay accept timeout", null, false));
        }, ACCEPT_TIMEOUT_MS);

        const nextLink = createRelayLink({
          localDeviceId: opts.deviceId,
          localAppVersion: opts.appVersion,
          send: (text) => socket.send(text),
          // The one broker slot (handler wired at boot on the node
          // binding, absent on the web). The link pins dispatch to the
          // injected channel itself, so what rides in here can never
          // widen the wire.
          broker: deps.broker,
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
                  // of its own. Peer brokering goes through
                  // connectBroker, so this seam only satisfies the
                  // shared DeviceConnection shape the supervisor
                  // expects.
                  invoke: () =>
                    Promise.reject(
                      new Error(
                        "the relay socket has no direct transport, use connectBroker",
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
                  socket.close();
                  // close() is advisory: node ws can hold it for ~30s
                  // against a stalled relay. Where the adapter can
                  // terminate, arm a short grace so it cannot.
                  if (socket.terminate !== undefined) {
                    setTimeout(() => socket.terminate?.(), TERMINATE_GRACE_MS);
                  }
                },
                remoteDeviceId: "",
                remoteAppVersion: "",
              });
            }
            notifyChange();
          },
        });

        socket.onMessage((text) => {
          // Once dead (owner close or a rejection), no further inbound
          // frame runs a handler even though the socket may still
          // deliver buffered frames while closing (S3).
          if (dead) return;
          // Wrap so a throw cannot escape into the platform's event
          // delivery and become an uncaught exception (M4).
          try {
            nextLink.handleMessage(text);
          } catch (error) {
            console.warn(
              `[relay] inbound message handler threw: ${errorMessageOf(error)}`,
            );
          }
        });
        socket.onClose((code) => {
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
    // Cancel any in-flight dial (mint fetch or half-open socket) so an
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

  return {
    connectBroker(deviceId) {
      if (link === null) {
        return Promise.reject(new RelayLinkDownError());
      }
      return link.connectBroker(deviceId);
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
      // The link owns the authoritative roster, so this reads it rather
      // than keeping a second copy that a stale generation's close
      // could wipe (C4). Presence includes the receiver per
      // protocol.ts, so the local device is filtered out.
      const online = (link?.onlineDeviceIds() ?? []).filter(
        (id) => id !== localDeviceId,
      );
      return {
        socket: socketStatus,
        onlineDeviceIds: online,
      };
    },
  };
}
