// The shared hub connection lifecycle: one outbound socket from this
// device to its account's Durable Object, driving the hub link. The
// node desktop connection (host/hub/connection.ts) and the browser
// connection (web/hub/connection.ts) were a near-verbatim fork of
// this machine and had already begun to drift, so the dial settle
// logic, the supervisor wiring and the refresh/stop/status lifecycle
// live here exactly once, behind a small socket adapter each platform
// implements over its own WebSocket.
//
// This file must stay electron-free and node-builtin-free (host:check):
// everything platform specific lives in the injected adapter, and
// everything account flavored (deviceId, appVersion, accountId, the
// credential-backed ticket mint) arrives through HubConnectOpts.
import { errorMessageOf } from "@shared/errors";
import {
  HELLO_TIMEOUT_MS,
  TERMINATE_GRACE_MS,
} from "@shared/ipc/socket/frames";
import {
  createHeartbeat,
  type HeartbeatOptions,
} from "@shared/ipc/socket/heartbeat";
import {
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import {
  createHubLink,
  type HubBroker,
  type HubBrokerSession,
  type HubLink,
  HubLinkDownError,
} from "@shared/hub/link";
import type {
  HubConnectOpts,
  HubConnectionStatus,
} from "@shared/hub/connectionTypes";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  CONNECT_TICKET_PARAM,
  HUB_PING,
  HUB_PONG,
  HUB_ROUTES,
} from "@shared/hub/protocol";
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
// knob because the device hub has one honest value here,
// HELLO_TIMEOUT_MS.
const ACCEPT_TIMEOUT_MS = HELLO_TIMEOUT_MS;

// One dialed hub socket as the platform adapter exposes it to the
// core. The adapter owns the platform WebSocket and its event wiring,
// the core owns everything above it.
export type HubSocketAdapter = {
  // Writes one text message. Throws when the socket is unusable (the
  // adapters throw HubLinkDownError before the socket is open), and
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

export type HubConnectionCoreDeps = {
  openSocket(url: string): HubSocketAdapter;
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its views.
  onChange?: () => void;
  // The channel-plus-handler pair the hub wire serves (see
  // HubBroker in link.ts), supplied by the composition so this core
  // never imports a contract. The node binding passes a facade over
  // its late-bound slot so registration at boot survives link
  // recreation across reconnects. A client-only platform (the web)
  // supplies the channel with no handler, leaving the host role empty
  // by construction: the link then answers every req with the
  // no-handler shape.
  broker: HubBroker;
  // Test seams for the liveness heartbeat (shared/ipc/socket/heartbeat.ts,
  // the rule the direct sockets follow too).
  heartbeat?: HeartbeatOptions;
};

// The lifecycle surface both platform bindings re-expose unchanged.
export type HubConnectionCore = {
  connectBroker(deviceId: string): Promise<HubBrokerSession>;
  refresh(resolve: () => Promise<HubConnectOpts | null>): Promise<void>;
  stop(): Promise<void>;
  status(): HubConnectionStatus;
  // Ask the device hub to prove the socket is still there NOW, under
  // the short probe window: fired on a wake from sleep or a tab coming
  // back. A socket that fails it is torn down and reported to the
  // supervisor exactly like a drop, so the redial starts in seconds
  // instead of whenever the OS notices the dead flow. A no-op while
  // nothing is established.
  probe(): void;
};

// The block-vs-retry rule for hub close codes. DEVICE_REVOKED is
// terminal until re-login. SUPERSEDED means another socket for this
// deviceId took over, and the losing side must not fight it, so it
// blocks with a distinct message. TICKET_REJECTED and everything else
// retry normally, since a fresh ticket is minted per attempt anyway.
const hubCloseClassifier: CloseClassifier = (code) => {
  if (code === CLOSE_DEVICE_REVOKED) {
    return {
      message: "this device was removed from the account, sign in again",
    };
  }
  if (code === CLOSE_SUPERSEDED) {
    return {
      message: "another instance of this device took over the device hub",
    };
  }
  return null;
};

// The connect URL: ws(s) scheme, the shared connect route, the ticket
// in the query string.
function connectUrlFor(hubUrl: string, ticket: string): string {
  const base = hubUrl.endsWith("/") ? hubUrl.slice(0, -1) : hubUrl;
  const wsBase = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const param = `${CONNECT_TICKET_PARAM}=${encodeURIComponent(ticket)}`;
  return `${wsBase}${HUB_ROUTES.connect.path}?${param}`;
}

function sameOpts(a: HubConnectOpts, b: HubConnectOpts): boolean {
  // mintTicket is a closure and deliberately not compared: it reads
  // the stored credential fresh on every attempt.
  return (
    a.hubUrl === b.hubUrl &&
    a.accountId === b.accountId &&
    a.deviceId === b.deviceId &&
    a.appVersion === b.appVersion
  );
}

// Prefer the adapter's hard terminate for a socket nothing should keep
// draining (an aborted or timed-out dial), falling back to the advisory
// close where the platform has nothing harder.
function killSocket(socket: HubSocketAdapter): void {
  if (socket.terminate !== undefined) socket.terminate();
  else socket.close();
}

export function createHubConnectionCore(
  deps: HubConnectionCoreDeps,
): HubConnectionCore {
  let link: HubLink | null = null;
  // The established connection as the supervisor reports it (null the
  // moment it is lost or torn down), so probe() reaches exactly the
  // live socket.
  let live: DeviceConnection | null = null;
  let current: { supervisor: Supervisor; opts: HubConnectOpts } | null = null;
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
    opts: HubConnectOpts,
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
      let ws: HubSocketAdapter | null = null;

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
        reject(new RemoteConnectError("hub dial cancelled", null, false));
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
          // A failed mint (offline, hub down, signed out mid-flight,
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
        const socket = deps.openSocket(connectUrlFor(opts.hubUrl, ticket));
        ws = socket;
        // Set true once stop() or a rejection lands, so no further
        // inbound frame runs a handler even while the socket drains (S3).
        let dead = false;
        // One close report per socket, whether the platform's close
        // event or the heartbeat's verdict lands first.
        let closeReported = false;
        const reportClose = (code: number | null): void => {
          if (closeReported) return;
          closeReported = true;
          if (established && !ownerClosed) onClose(code);
        };

        // Liveness (shared/ipc/socket/heartbeat.ts), armed at the accept.
        // Enforced from the first ping on purpose (no "seen a pong yet"
        // latch): a socket that dies right after the accept must still
        // be found, and the cost of that is only that a Worker
        // predating the pair (which drops pings as malformed envelopes)
        // is redialed once a minute until it is redeployed, so the
        // Worker deploys first (hub/README.md). A death tears the link
        // down and reports to the supervisor like a drop.
        const heartbeat = createHeartbeat({
          ...deps.heartbeat,
          sendPing: () => socket.send(HUB_PING),
          onDead: () => {
            if (dead) return;
            dead = true;
            if (link === nextLink) link = null;
            nextLink.teardown();
            killSocket(socket);
            reportClose(null);
            notifyChange();
          },
        });

        const acceptTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearPending();
          killSocket(socket);
          reject(new RemoteConnectError("hub accept timeout", null, false));
        }, ACCEPT_TIMEOUT_MS);

        const nextLink = createHubLink({
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
              heartbeat.start();
              resolve({
                transport: {
                  // The hub socket carries no direct sm transport
                  // of its own. Peer brokering goes through
                  // connectBroker, so this seam only satisfies the
                  // shared DeviceConnection shape the supervisor
                  // expects.
                  invoke: () =>
                    Promise.reject(
                      new Error(
                        "the hub socket has no direct transport, use connectBroker",
                      ),
                    ),
                  subscribe: () => () => {},
                },
                close: () => {
                  ownerClosed = true;
                  dead = true;
                  heartbeat.stop();
                  // Tear the link down SYNCHRONOUSLY so host sessions
                  // abort at once and no in-flight handler answers into a
                  // dead socket, rather than waiting on the close event
                  // (S3).
                  if (link === nextLink) link = null;
                  nextLink.teardown();
                  socket.close();
                  // close() is advisory: node ws can hold it for ~30s
                  // against a stalled device hub. Where the adapter can
                  // terminate, arm a short grace so it cannot.
                  if (socket.terminate !== undefined) {
                    setTimeout(() => socket.terminate?.(), TERMINATE_GRACE_MS);
                  }
                },
                probe: heartbeat.probe,
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
          // Any inbound message proves the hub alive; a pong is not an
          // envelope, so it stops here.
          heartbeat.noteInbound();
          if (text === HUB_PONG) return;
          // Wrap so a throw cannot escape into the platform's event
          // delivery and become an uncaught exception (M4).
          try {
            nextLink.handleMessage(text);
          } catch (error) {
            console.warn(
              `[hub] inbound message handler threw: ${errorMessageOf(error)}`,
            );
          }
        });
        socket.onClose((code) => {
          dead = true;
          clearTimeout(acceptTimer);
          clearPending();
          heartbeat.stop();
          if (link === nextLink) link = null;
          nextLink.teardown();
          if (!settled) {
            settled = true;
            reject(
              new RemoteConnectError(
                `hub closed before accept (code ${code})`,
                code,
                hubCloseClassifier(code) !== null,
              ),
            );
            notifyChange();
            return;
          }
          // An established socket dropped. The owner-close path stays
          // silent so the supervisor never reconnects against its own
          // stop, and a heartbeat death already reported itself.
          reportClose(code);
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

  function startNow(opts: HubConnectOpts): void {
    const connect: ConnectFn = (connectOpts) => dial(opts, connectOpts.onClose);
    const supervisor = createSupervisor({
      // The params satisfy the supervisor's LAN-oriented shape. Only
      // url is meaningful here, and the token is empty by design.
      params: {
        url: opts.hubUrl,
        token: "",
        appVersion: opts.appVersion,
        localDeviceId: opts.deviceId,
      },
      connect,
      classifyClose: hubCloseClassifier,
      onStatus: (next) => {
        socketStatus = next;
        notifyChange();
      },
      onConnection: (connection) => {
        live = connection;
      },
    });
    current = { supervisor, opts };
    supervisor.start();
  }

  return {
    connectBroker(deviceId) {
      if (link === null) {
        return Promise.reject(new HubLinkDownError());
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

    probe: () => {
      live?.probe();
    },

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
