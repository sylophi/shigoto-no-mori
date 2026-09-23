// The client half of port forwarding (byte
// channels): binds loopback listeners on this machine and
// bridges each accepted socket onto a channel of the peer's direct
// session, opened with forward:open (the host side in
// host/ipc/modules/forward.ts, the wire rules in
// shared/ipc/modules/forward.ts). Electron-free on purpose, node:net
// plus injected dependencies, so the e2e check drives the real engine
// over a real device wire (test/port-forward.mjs) while
// main/ipc wires the peer reach over the bridge's shared direct
// sessions.
//
// The per-socket bridging (attach, open, the adapter's backpressure and
// teardown) lives in bridge.ts, shared with the mirror gateway. This
// file owns the listeners, the per-device conn cap and the forward
// registry.
//
// Lifetimes are Effect scopes. The engine has one; each forward is a
// child scope holding its listener, and each accepted conn a child of
// its forward's scope holding its cap permit and its bridged socket. So
// stopForward is closing the forward's scope (the listener closes, and
// every conn is reset and destroyed with it), a conn ending on its own
// closes only its own scope, and stopAll closes the engine's scope,
// which is terminal: a start in flight is interrupted and a later one
// refused. Starts run as fibers forked into the engine's scope.
import { Cause, Effect, Exit, Fiber, Schema, Scope, Semaphore } from "effect";
import type { Socket } from "node:net";
import { coalesce } from "@host/lib/util/coalesce";
import {
  errorCodeOf,
  isForwardConnectFailedError,
  PortDenied,
  PortInUse,
} from "@shared/errors";
import type { forwardContract } from "@shared/ipc/modules/forward";
import type { Client } from "@shared/ipc/types";
import {
  defaultSupervisorRuntime,
  type SupervisorRuntime,
} from "@shared/remote/supervisor";
import { mintHexId } from "@host/lib/idleRegistry";
import { bridgedConn, loopbackListener, type PeerChannels } from "./bridge";

export type ForwardApi = Client<typeof forwardContract>;

// Client-side cap on live conns per device, under the host's own
// per-connection channel cap (host/ipc/modules/forward.ts): sized so
// one browser tab's ~6 keepalive sockets plus an HMR websocket fit
// with headroom. Per host process, so this count spans ALL forwards to
// one device, not each forward alone. A conn over the cap would be
// refused there anyway, but only after a full open round trip, so an
// accepted socket over the cap is destroyed immediately instead.
// Exported so the port-forward check's cap scenario tracks this value.
export const MAX_CONNS_PER_DEVICE = 16;

// Trailing coalesce for the changed signal: opens and closes arrive
// in bursts (one page load moves ~a dozen conns), and each signal
// triggers a renderer list refetch, so burst members collapse into one
// signal shortly after the first.
export const CHANGE_COALESCE_MS = 150;

// A start that arrived after (or was in flight at) stopAll, the quit
// teardown. Only this module raises it.
export class PortForwardStopped extends Schema.TaggedError<PortForwardStopped>()(
  "PortForwardStopped",
  {},
) {
  override get message(): string {
    return "port forwarding has stopped";
  }
}

export type PortForwardSummary = {
  forwardId: string;
  deviceId: string;
  remotePort: number;
  localPort: number;
  connCount: number;
};

type Forward = {
  forwardId: string;
  deviceId: string;
  remotePort: number;
  localPort: number;
  // The forward's lifetime: its listener, and every accepted conn as a
  // child scope. stopForward closes it.
  scope: Scope.Closeable;
  // The conns whose far end opened, which is what the summary counts: a
  // dial to a port with nothing behind it never shows as a conn.
  opened: Set<object>;
  api: ForwardApi;
  channels: PeerChannels;
};

export type PortForwardEngine = ReturnType<typeof createPortForwardEngine>;

// The bind errnos a person can act on (another local port, one above
// 1024), typed for the forward UI (renderer/hooks/remote/
// usePortForwards.ts). Any other bind failure passes through as node
// raised it.
function typedBindError(error: unknown, port: number): unknown {
  switch (errorCodeOf(error)) {
    case "EADDRINUSE":
      return new PortInUse({ port });
    case "EACCES":
      return new PortDenied({ port });
    default:
      return error;
  }
}

// The owner's change callback runs off the coalesce timer, where a
// throw would be an uncaught exception. Contained and logged instead.
function guarded(what: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.warn(`[port-forward] ${what} threw: ${String(error)}`);
  }
}

// Probe the peer before binding anything: one channel opened and
// reset at once, so a revoked grant or an offline peer rejects the
// start with its coded error instead of minting a listener whose
// conns die on arrival. A port with nothing listening yet is NOT a
// rejection: the forward is a standing intent, so it binds anyway
// and each conn dials the port afresh, which means a dev server
// started later is reached without touching the switch again. Until
// then a local dial is accepted and closed, which a browser shows
// as an empty response.
const probePeer = Effect.fnUntraced(function* (
  api: ForwardApi,
  channels: PeerChannels,
  port: number,
) {
  const mux = yield* Effect.tryPromise({
    try: () => channels(),
    catch: (error) => error,
  });
  const probeId = mintHexId();
  yield* Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        mux.attach(probeId, {
          onData: (_data, consumed) => consumed(),
          onEnd: () => {},
          onReset: () => {},
          onWritable: () => {},
        }),
      catch: (error) => error,
    }),
    () =>
      Effect.tryPromise({
        try: () => api.open({ port, channelId: probeId }),
        catch: (error) => error,
      }).pipe(Effect.catchIf(isForwardConnectFailedError, () => Effect.void)),
    (probe) =>
      Effect.sync(() => {
        probe.reset();
      }),
  );
});

export function createPortForwardEngine(deps: {
  forwardApiFor: (deviceId: string) => ForwardApi;
  // The peer session's byte channels (bridge.ts PeerChannels).
  channelsFor: (deviceId: string) => PeerChannels;
  onChange?: () => void;
  // Where the engine's effects run. Real callers take Effect's default
  // services.
  runtime?: SupervisorRuntime;
}) {
  const runtime = deps.runtime ?? defaultSupervisorRuntime;
  // The engine's lifetime: every forward's scope and every start's
  // fiber lives in it, and stopAll closes it.
  const scope = Scope.makeUnsafe();
  const forwards = new Map<string, Forward>();
  // The per-device cap: a conn holds one permit from accept until its
  // scope closes. One semaphore per device ever forwarded to, kept for
  // the engine's life (a handful), so a forward being moved and its
  // replacement can never count against two different ones.
  const caps = new Map<string, Semaphore.Semaphore>();
  const changed = coalesce(
    () => guarded("onChange", () => deps.onChange?.()),
    CHANGE_COALESCE_MS,
  );

  // Closed as of now (listForwards and a re-entrant close see it at
  // once), its finalizers run on the runtime, synchronously on the
  // default one. Closing a closed scope is a no-op.
  function closeNow(target: Scope.Closeable): void {
    const finalize = Scope.closeUnsafe(target, Exit.void);
    if (finalize !== undefined) runtime.runFork(finalize);
  }

  function capFor(deviceId: string): Semaphore.Semaphore {
    let cap = caps.get(deviceId);
    if (cap === undefined) {
      cap = Semaphore.makeUnsafe(MAX_CONNS_PER_DEVICE);
      caps.set(deviceId, cap);
    }
    return cap;
  }

  function findForward(
    deviceId: string,
    remotePort: number,
  ): Forward | undefined {
    for (const forward of forwards.values()) {
      if (forward.deviceId === deviceId && forward.remotePort === remotePort) {
        return forward;
      }
    }
    return undefined;
  }

  // One accepted local socket, run synchronously from the listener's
  // connection event. Over the device's cap it is destroyed before any
  // wire traffic. Otherwise it gets a child scope of its forward
  // holding the permit and the bridged conn, closed by the conn ending
  // on its own or by the forward's teardown. A forward already closed
  // yields a closed child, which releases both at once.
  const accept = Effect.fnUntraced(
    function* (forward: Forward, socket: Socket) {
      const cap = capFor(forward.deviceId);
      if (!(yield* Semaphore.takeIfAvailable(cap, 1))) {
        socket.destroy();
        return;
      }
      const connScope = yield* Scope.fork(forward.scope);
      yield* Scope.addFinalizer(connScope, Semaphore.release(cap, 1));
      const token = {};
      yield* bridgedConn(socket, {
        channels: forward.channels,
        open: (channelId) =>
          forward.api.open({ port: forward.remotePort, channelId }),
        onOpened: () => {
          forward.opened.add(token);
          changed();
        },
        onClosed: () => {
          if (forward.opened.delete(token)) changed();
          closeNow(connScope);
        },
      }).pipe(Scope.provide(connScope));
    },
    (effect, _forward, socket) =>
      Effect.catchCause(effect, (cause) =>
        Effect.sync(() => {
          socket.destroy();
          console.warn(`[port-forward] accept failed: ${Cause.pretty(cause)}`);
        }),
      ),
  );

  const start = Effect.fnUntraced(function* (input: {
    deviceId: string;
    remotePort: number;
    localPort?: number;
  }) {
    // One forward per (deviceId, remotePort): starting an existing pair
    // returns it unchanged, unless the caller names a different local
    // port, which moves the listener there. The old listener stays up
    // until the new one is bound (below), so a move that fails (port
    // taken, peer gone) leaves the working forward exactly as it was.
    // Idempotent otherwise, the simpler contract for a UI whose start
    // doubles as "make sure this is forwarded".
    const existing = findForward(input.deviceId, input.remotePort);
    if (
      existing !== undefined &&
      (input.localPort === undefined || input.localPort === existing.localPort)
    ) {
      return { forwardId: existing.forwardId, localPort: existing.localPort };
    }
    const api = yield* Effect.try({
      try: () => deps.forwardApiFor(input.deviceId),
      catch: (error) => error,
    });
    const channels = yield* Effect.try({
      try: () => deps.channelsFor(input.deviceId),
      catch: (error) => error,
    });
    yield* probePeer(api, channels, input.remotePort);
    const forward: Forward = {
      forwardId: mintHexId(),
      deviceId: input.deviceId,
      remotePort: input.remotePort,
      localPort: 0,
      scope: yield* Scope.fork(scope),
      opened: new Set(),
      api,
      channels,
    };
    const bound = yield* loopbackListener(input.localPort ?? 0, (socket) => {
      runtime.runFork(accept(forward, socket));
    }).pipe(
      Effect.mapError((error) => typedBindError(error, input.localPort ?? 0)),
      Scope.provide(forward.scope),
      // A failed bind (or an interrupt) leaves no forward behind.
      Effect.onError(() => Scope.close(forward.scope, Exit.void)),
    );
    forward.localPort = bound.port;
    // The dedupe scan above ran before the probe and the bind, so a
    // concurrent start for the same pair may have bound in the
    // meantime: yield to the twin and release the just-bound listener.
    // The forward being moved is not a twin: it is what the new
    // listener replaces, and only now, with the replacement bound,
    // does it go.
    const twin = findForward(input.deviceId, input.remotePort);
    if (twin !== undefined && twin !== existing) {
      yield* Scope.close(forward.scope, Exit.void);
      return { forwardId: twin.forwardId, localPort: twin.localPort };
    }
    if (existing !== undefined) stopForward(existing.forwardId);
    forwards.set(forward.forwardId, forward);
    changed();
    return { forwardId: forward.forwardId, localPort: forward.localPort };
  });

  function startForward(input: {
    deviceId: string;
    remotePort: number;
    localPort?: number;
  }): Promise<{ forwardId: string; localPort: number }> {
    return runtime.runPromise(
      Effect.forkIn(start(input), scope).pipe(
        Effect.flatMap(Fiber.join),
        // Interrupted means stopAll won: in flight, or after (a fork
        // into the closed scope is interrupted before it runs).
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.fail(new PortForwardStopped())
            : Effect.failCause(cause),
        ),
      ),
    );
  }

  // Idempotent: stopping an unknown or already-stopped forward is a
  // no-op. The listener closes and every live conn is reset and
  // destroyed, with its forward's scope.
  function stopForward(forwardId: string): void {
    const forward = forwards.get(forwardId);
    if (forward === undefined) return;
    forwards.delete(forwardId);
    closeNow(forward.scope);
    changed();
  }

  function listForwards(): PortForwardSummary[] {
    return [...forwards.values()].map((forward) => ({
      forwardId: forward.forwardId,
      deviceId: forward.deviceId,
      remotePort: forward.remotePort,
      localPort: forward.localPort,
      connCount: forward.opened.size,
    }));
  }

  // Shutdown teardown, terminal. Synchronous on the local side
  // (listeners and sockets die now), best-effort on the wire. Closing
  // the engine's scope closes every forward's and interrupts every
  // start in flight. Idempotent.
  function stopAll(): void {
    const had = forwards.size > 0;
    forwards.clear();
    closeNow(scope);
    if (had) changed();
  }

  // Every forward onto a device `keep` refuses: the peer left the
  // account, so its loopback listener would only ever black-hole.
  function stopForwardsTo(keep: (deviceId: string) => boolean): void {
    for (const forward of forwards.values()) {
      if (!keep(forward.deviceId)) stopForward(forward.forwardId);
    }
  }

  return { startForward, stopForward, listForwards, stopAll, stopForwardsTo };
}
