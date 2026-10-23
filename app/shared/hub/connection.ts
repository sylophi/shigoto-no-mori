// The shared hub connection lifecycle: one outbound socket from this
// device to its account's Durable Object, driving the hub link. The
// desktop connection (host/hub/connection.ts) and the browser's
// (web/hub/connection.ts) share the dial settle logic, the supervisor
// wiring, the socket's liveness and the refresh/status lifecycle here,
// each through a small adapter over its own WebSocket. The connection
// lives as long as the scope it is made in, whose close takes the
// socket down.
//
// This file must stay electron-free and node-builtin-free: everything
// platform specific lives in the injected adapter, and everything
// account flavored (deviceId, accountId, the credential-backed ticket
// mint) arrives through HubConnectOpts.
import {
  HubRateLimitedError,
  isHubDeviceRevoked,
  isHubRefusal,
  errorMessageOf,
} from "@shigomori/contracts/errors";
import {
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
} from "@shared/remote/link";
import { watchLiveness } from "@shigomori/engine/liveness";
import { RemoteConnectError } from "@shared/remote/deviceLink";
import { newConnectionId } from "@shigomori/engine/rpcClient";
import {
  createHubLink,
  type HubLink,
  HubLinkDownError,
  type SeenAsks,
  type ServeConnectInfo,
} from "@shared/hub/link";
import type {
  HubConnectOpts,
  HubConnectionStatus,
} from "@shared/hub/connectionTypes";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { HubApi } from "@shigomori/contracts/hubApi";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  HUB_PING,
  HUB_PONG,
} from "@shigomori/contracts/hubProtocol";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  type CloseClassifier,
  type SupervisedConnection,
  type Supervisor,
  type SupervisorStatus,
  supervise,
} from "@shared/remote/supervisor";
import { log } from "@shared/log";
import { elapsedMillisUnsafe } from "@shigomori/engine/elapsed";
import { deviceKeyPair } from "@shared/crypto/deviceKey";
import type { KeyPair } from "@shared/crypto/noise";

// The deadline for one dial phase: the ticket mint, and separately the
// socket accept (the first presence envelope). Named rather than a bare
// knob because the device hub has one honest value here,
// HELLO_TIMEOUT_MS.
const ACCEPT_TIMEOUT_MS = HELLO_TIMEOUT_MS;

// After an owner close, how long a stalled device hub has before its
// socket is cut, so it cannot hold the close for ws's ~30s window.
const TERMINATE_GRACE_MS = 1_500;

// A websocket over a NAT, a tunnel edge or a laptop that just slept can
// die without either end seeing a close, so the socket is watched as a
// device link is (engine/liveness.ts, on link.ts's timings): the
// hub's ping (HUB_PING, which the Durable Object answers without
// waking) as the probe, and any inbound frame as its answer, a relay or
// presence proving the hub alive as well as a pong does. A probe (a
// wake from sleep, a tab coming back) is a fresh ping at once. A hidden
// tab's turns all come late, so it judges nothing until it comes back.

// Test seams for the pings' timing. Real callers take the defaults.
type PingOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  probeTimeoutMs?: number;
};

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
  // Delivers each inbound text message. The adapter drops binary
  // frames: the protocol is JSON text, so they are not part of it.
  onMessage(handler: (text: string) => void): void;
  // Delivers the close code once the socket is gone. Platform error
  // events carry no useful detail and are always followed by close, so
  // the adapter swallows them and this is the one teardown signal.
  onClose(handler: (code: number) => void): void;
  // Delivers the status the hub answered the upgrade with instead of
  // accepting it, and its Retry-After, ahead of the close. Only where
  // the platform shows it (node ws): a browser's socket reports a
  // refused upgrade as a bare close.
  onRefused?(
    handler: (status: number, retryAfterSeconds: number | undefined) => void,
  ): void;
};

export type HubConnectionDeps = {
  openSocket(url: string): HubSocketAdapter;
  // Fired on every supervisor or presence transition, so the owner can
  // fan a status snapshot out to its views.
  onChange?: () => void;
  // The connectInfo server (see ServeConnectInfo in link.ts), handed
  // to every link generation. Absent on a platform with no direct
  // listener (the web), whose link then answers every ask with the
  // no-listener refusal.
  serveConnectInfo?: ServeConnectInfo;
  ping?: PingOptions;
};

// The lifecycle surface both platform bindings re-expose unchanged.
export type HubConnection = {
  // Ask one peer for its connect info (HubLink.askConnectInfo).
  // Rejects with HubLinkDownError while the socket is down.
  askConnectInfo(
    deviceId: string,
    input: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  // Reconciles the connection with the wanted state, one refresh at a
  // time so a fast account double-toggle cannot interleave one
  // refresh's stop with another's start. `resolve` runs inside, and
  // null means stop (signed out or unconfigured).
  refresh(resolve: Effect.Effect<HubConnectOpts | null>): Effect.Effect<void>;
  status(): HubConnectionStatus;
  // What the device link's handshakes are made of: this device's key
  // pair, and the key the hub's roster names for a peer. Null and
  // undefined while signed out or the socket is down.
  localKey(): KeyPair | null;
  peerKey(deviceId: string): Uint8Array | undefined;
  // Whether the roster is known at all: false while the hub socket is
  // down, when a missing key says nothing about the device.
  rosterKnown(): boolean;
  // Ask the device hub to prove the socket is still there now, under
  // the short probe window: fired on a wake from sleep or a tab coming
  // back. A socket that fails it is torn down and reported to the
  // supervisor exactly like a drop, so the redial starts in seconds
  // instead of whenever the OS notices the dead flow. While nothing is
  // established, a supervisor in backoff dials now: fired on the
  // network coming back too, the first attempt is immediate.
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
      reason: "revoked",
      message: "this device was removed from the account, sign in again",
    };
  }
  if (code === CLOSE_SUPERSEDED) {
    return {
      reason: "superseded",
      message: "another instance of this device took over the device hub",
    };
  }
  return null;
};

// The connect URL: the shared connect route with the ticket in the
// query string, on the ws(s) scheme.
function connectUrlFor(hubUrl: string, ticket: string): string {
  const baseUrl = hubUrl
    .replace(/\/+$/, "")
    .replace(/^https:/, "wss:")
    .replace(/^http:/, "ws:");
  return HttpApiClient.urlBuilder(HubApi, { baseUrl }).connect({
    query: { ticket },
  });
}

function sameOpts(a: HubConnectOpts, b: HubConnectOpts): boolean {
  // mintTicket is a closure and deliberately not compared: it reads
  // the stored credential fresh on every attempt. A new device key (an
  // enrollment again) redials, so the roster hands peers the new one.
  return (
    a.hubUrl === b.hubUrl &&
    a.accountId === b.accountId &&
    a.deviceId === b.deviceId &&
    a.deviceKey === b.deviceKey
  );
}

// Prefer the adapter's hard terminate for a socket nothing should keep
// draining (an aborted or timed-out dial, a dead one), falling back to
// the advisory close where the platform has nothing harder.
function killSocket(socket: HubSocketAdapter): void {
  if (socket.terminate !== undefined) socket.terminate();
  else socket.close();
}

export const make = (
  deps: HubConnectionDeps,
): Effect.Effect<HubConnection, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const clock = yield* Clock.Clock;
    const lifecycle = yield* Semaphore.make(1);
    const intervalMs = deps.ping?.intervalMs ?? PING_INTERVAL_MS;
    const timeoutMs = deps.ping?.timeoutMs ?? PING_TIMEOUT_MS;
    const probeTimeoutMs = deps.ping?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    let link: HubLink | null = null;
    // Kept across the links a redial replaces (link.ts, SeenAsks).
    const seenAsks: SeenAsks = new Map();
    // The established connection as the supervisor reports it (null the
    // moment it is lost or torn down), so probe() reaches exactly the
    // live socket.
    let live: SupervisedConnection | null = null;
    // The supervisor for the current inputs, in a scope of its own the
    // next refresh closes.
    let current: {
      scope: Scope.Closeable;
      supervisor: Supervisor;
      opts: HubConnectOpts;
    } | null = null;
    let socketStatus: SupervisorStatus = { phase: "idle" };
    // This socket's name on the hub, kept across redials. A web device
    // holds one per tab, and the hub relays to each.
    const connectionId = newConnectionId();
    // The peers the last roster named, across redials, so the log says
    // who came and went, the one record of a peer's presence there is.
    let roster: ReadonlySet<string> = new Set();
    const noteRoster = (online: readonly string[], self: string) => {
      const next = new Set(online.filter((id) => id !== self));
      for (const id of next) {
        if (!roster.has(id)) log.info(`[hub] ${id} came online`);
      }
      for (const id of roster) {
        if (!next.has(id)) log.info(`[hub] ${id} went offline`);
      }
      roster = next;
    };

    function notifyChange(): void {
      deps.onChange?.();
    }

    // One connect attempt: mint a fresh ticket, dial the DO, and treat
    // the first presence envelope as the accept signal (the DO sends it
    // right after accepting, and a rejected ticket never gets one, only
    // a close). The connection is the supervisor's shape, a probe only.
    // The socket lives as long as the attempt's scope, and an interrupt
    // (the supervisor stopping) cancels a mint or a half-open socket.
    const dial = (
      opts: HubConnectOpts,
      onClose: (code: number | null) => void,
    ): Effect.Effect<SupervisedConnection, RemoteConnectError, Scope.Scope> =>
      Effect.gen(function* () {
        // The mint has its own deadline so a black-holed route cannot
        // strand the supervisor in "connecting" forever.
        const ticket = yield* Effect.tryPromise({
          try: (signal) => opts.mintTicket(connectionId, signal),
          // A failed mint (offline, hub down, signed out mid-flight) is
          // a retryable connect failure. A refusal is not: the device
          // hub rejecting this credential is deterministic until the
          // account changes, so it blocks the supervisor (terminal
          // until refresh restarts it on the next sign-in or sign-out)
          // instead of minting on the ladder forever. The message rides
          // along so the UI can name it. A mint refused because the
          // credential was revoked (the device was removed from the
          // account while this socket was down, so it never saw the
          // revoked close) carries the revoked close code, so the
          // classifier blocks it as "revoked" and the app signs out
          // exactly as it would have on the close.
          catch: (error) =>
            new RemoteConnectError(
              `ticket mint failed: ${errorMessageOf(error)}`,
              isHubDeviceRevoked(error) ? CLOSE_DEVICE_REVOKED : null,
              isHubRefusal(error),
              error instanceof Error ? error : undefined,
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: ACCEPT_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new RemoteConnectError("hub dial cancelled", null, false),
              ),
          }),
        );

        // Set once the socket's end is decided (the owner's close, its
        // own close, a death), so no further inbound frame runs a
        // handler even while the socket drains.
        let dead = false;
        let established = false;
        // The close is this side's: the platform close that follows it
        // stays silent, so the supervisor never reconnects against it.
        let ownerClosed = false;
        const accepted = yield* Deferred.make<void, RemoteConnectError>();
        // The link half of a teardown, shared by every path that ends
        // this socket (owner close, platform close, a death).
        const tearDownLink = (): void => {
          if (link === nextLink) link = null;
          nextLink.teardown();
        };
        const socket = yield* Effect.acquireRelease(
          Effect.sync(() =>
            deps.openSocket(connectUrlFor(opts.hubUrl, ticket)),
          ),
          (opened) =>
            Effect.sync(() => {
              const wasDead = dead;
              ownerClosed = true;
              dead = true;
              // Torn down at once, so pending asks reject rather than
              // wait on the close event.
              tearDownLink();
              if (wasDead) return;
              if (!established) {
                // A dial cut short: no orphan socket can complete after
                // the stop and be superseded into a terminal block.
                killSocket(opened);
                return;
              }
              opened.close();
              // close() is advisory: node ws can hold it for ~30s
              // against a stalled device hub. Where the adapter can
              // terminate, arm a short grace so it cannot.
              if (opened.terminate !== undefined) {
                setTimeout(() => opened.terminate?.(), TERMINATE_GRACE_MS);
              }
            }),
        );

        const nextLink = createHubLink({
          localDeviceId: opts.deviceId,
          localKey: deviceKeyPair(opts.deviceKey),
          seenAsks,
          now: () => elapsedMillisUnsafe(clock),
          send: (text) => socket.send(text),
          serveConnectInfo: deps.serveConnectInfo,
          onPresence: (online) => {
            // The teardown's empty roster on a dead socket is not a
            // live roster: it must not reach the direct plane while the
            // supervisor still reads the socket as connected (that
            // would close every direct session on a hub blip). The
            // drop itself notifies, once, after the supervisor knows.
            if (dead) return;
            if (!established) {
              established = true;
              link = nextLink;
              log.info("[hub] connected");
              Deferred.doneUnsafe(accepted, Exit.void);
            }
            noteRoster(online, opts.deviceId);
            notifyChange();
          },
        });

        // The hub's rate limit on the upgrade itself (its 60 opens a
        // minute), which the supervisor waits out before dialing again.
        let rateLimited: HubRateLimitedError | undefined;
        socket.onRefused?.((status, retryAfterSeconds) => {
          if (status !== 429) return;
          rateLimited = new HubRateLimitedError(
            retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
          );
        });

        // Inbound frames so far: a probe is answered by any frame after
        // its own ping, whatever the clocks did meanwhile.
        let framesSeen = 0;
        // When the last frame came, on both clocks, so a death can tell a
        // sleep (wall time ran on, monotonic stood still) from silence.
        let lastFrame = {
          wall: clock.currentTimeMillisUnsafe(),
          elapsed: elapsedMillisUnsafe(clock),
        };

        socket.onMessage((text) => {
          if (dead) return;
          // Any inbound message proves the hub alive. A pong is not an
          // envelope, so it stops here.
          framesSeen += 1;
          lastFrame = {
            wall: clock.currentTimeMillisUnsafe(),
            elapsed: elapsedMillisUnsafe(clock),
          };
          if (text === HUB_PONG) return;
          // Wrap so a throw cannot escape into the platform's event
          // delivery and become an uncaught exception.
          try {
            nextLink.handleMessage(text);
          } catch (error) {
            log.warn(
              `[hub] inbound message handler threw: ${errorMessageOf(error)}`,
            );
          }
        });
        socket.onClose((code) => {
          dead = true;
          tearDownLink();
          if (!established) {
            Deferred.doneUnsafe(
              accepted,
              Exit.fail(
                rateLimited === undefined
                  ? new RemoteConnectError(
                      `hub closed before accept (code ${code})`,
                      code,
                      hubCloseClassifier(code) !== null,
                    )
                  : new RemoteConnectError(
                      rateLimited.message,
                      code,
                      false,
                      rateLimited,
                    ),
              ),
            );
          } else if (!ownerClosed) {
            // An established socket dropped. The owner's close and a
            // death stay silent, so the supervisor never reconnects
            // against its own stop and hears a death once.
            log.info(`[hub] the socket closed (code ${code})`);
            onClose(code);
          }
          notifyChange();
        });

        yield* Deferred.await(accepted).pipe(
          Effect.timeoutOrElse({
            duration: ACCEPT_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new RemoteConnectError("hub accept timeout", null, false),
              ),
          }),
        );

        // A socket that stopped answering: torn down and reported to the
        // supervisor like a drop, once, before the kill, so the
        // platform close it triggers stays silent however promptly it
        // lands. Closed without waiting on the platform's close
        // handshake, which against a dead peer can take a browser a
        // minute.
        const declareDead = Effect.sync(() => {
          if (dead) return;
          // macOS's monotonic clock stops while the machine sleeps, so
          // the wall time it lags since the last frame is the sleep (or a
          // forward clock step, which only this line can mistake for one).
          const sleptMs =
            clock.currentTimeMillisUnsafe() -
            lastFrame.wall -
            (elapsedMillisUnsafe(clock) - lastFrame.elapsed);
          log.info(
            sleptMs >= 60_000
              ? `[hub] woke after ${Math.round(sleptMs / 60_000)} min, and the socket had not lived through it`
              : "[hub] the socket stopped answering its pings",
          );
          dead = true;
          tearDownLink();
          onClose(null);
          ownerClosed = true;
          killSocket(socket);
          notifyChange();
        });
        // Enforced from the first ping on purpose (no "seen a pong yet"
        // latch): a socket that dies right after the accept must still
        // be found. A ping the wire refused is left to the close that
        // follows.
        const liveness = yield* watchLiveness({
          ping: Effect.try(() => socket.send(HUB_PING)).pipe(
            Effect.andThen(Effect.never),
          ),
          heard: () => framesSeen,
          intervalMs,
          timeoutMs,
          probeTimeoutMs,
          dead: declareDead,
        });
        return {
          probe: () => {
            if (!dead) liveness.probe();
          },
        };
      });

    // Ends the supervisor, which ends any dial in flight and closes the
    // live socket.
    const stopNow = Effect.suspend(() => {
      if (current === null) return Effect.void;
      const stopping = current.scope;
      current = null;
      return Scope.close(stopping, Exit.void);
    });

    const startNow = (opts: HubConnectOpts) =>
      Effect.gen(function* () {
        const child = yield* Scope.fork(scope);
        const supervisor = yield* supervise({
          connect: (onClose) => dial(opts, onClose),
          classifyClose: hubCloseClassifier,
          onStatus: (next) => {
            if (next.phase === "blocked" && socketStatus.phase !== "blocked") {
              log.warn(`[hub] blocked (${next.reason}): ${next.message}`);
            }
            socketStatus = next;
            notifyChange();
          },
          onConnection: (connection) => {
            live = connection;
          },
        }).pipe(Scope.provide(child));
        current = { scope: child, supervisor, opts };
      });

    return {
      localKey() {
        return current === null ? null : deviceKeyPair(current.opts.deviceKey);
      },

      peerKey(deviceId) {
        return link?.publicKeyOf(deviceId);
      },

      rosterKnown() {
        return link !== null;
      },

      askConnectInfo(deviceId, input, askMs, signal) {
        if (link === null) {
          return Promise.reject(new HubLinkDownError());
        }
        return link.askConnectInfo(deviceId, input, askMs, signal);
      },

      refresh: (resolve) =>
        lifecycle.withPermit(
          Effect.gen(function* () {
            const opts = yield* resolve;
            if (opts === null) return yield* stopNow;
            // A blocked supervisor restarts on refresh: refresh only
            // runs when inputs may have changed (boot, sign-in,
            // sign-out, rename), and blocked is terminal precisely until
            // then.
            if (
              current !== null &&
              sameOpts(current.opts, opts) &&
              socketStatus.phase !== "blocked"
            ) {
              return;
            }
            yield* stopNow;
            yield* startNow(opts);
          }),
        ),

      probe: () => {
        // A live socket gets its verdict within the probe's window, a
        // supervisor waiting out its backoff dials now, and either way
        // the uptime the ladder reads starts again here.
        live?.probe();
        current?.supervisor.dialNow();
      },

      status: () => {
        const localDeviceId = current?.opts.deviceId;
        // The link owns the authoritative roster, so this reads it rather
        // than keeping a second copy that a stale generation's close
        // could wipe. Presence includes the receiver per
        // protocol.ts, so the local device is filtered out.
        const online = (link?.onlineDeviceIds() ?? []).filter(
          (id) => id !== localDeviceId,
        );
        return {
          // Connected only while the link is up: a socket's end tears
          // the link down before the supervisor hears of it, and a
          // connected socket with no roster would read as every peer
          // gone (directPresence.ts) on a hub blip.
          socket:
            socketStatus.phase === "connected" && link === null
              ? { phase: "connecting" }
              : socketStatus,
          onlineDeviceIds: online,
        };
      },
    } satisfies HubConnection;
  });
