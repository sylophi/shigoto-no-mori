// The client half of port forwarding (byte
// channels): binds loopback listeners on this machine and
// bridges each accepted socket onto a channel of the peer's direct
// session, opened with forward:open (the host side in
// host/ipc/modules/forward.ts, the wire rules in
// packages/contracts/src/modules/forward.ts). Its peer reach is
// injected (PortForwards.ts passes PeerReach's), so the proof drives
// the real engine over a real device wire (test/port-forward.mts).
//
// The per-socket bridging (attach, open, the adapter's backpressure and
// teardown) lives in bridge.ts, shared with the mirror gateway. This
// file owns the listeners, the per-device conn cap and the forward
// registry. Each forward is a scope of the engine's: its listener, its
// conns and their opens end when it closes, which a stop and the
// engine's own close do.
import { createServer, type Socket } from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { forwardContract } from "@shigomori/contracts/modules/forward";
import {
  callFailureOf,
  isForwardConnectFailedError,
} from "@shigomori/contracts/errors";
import type {
  PortForwardSummary,
  PortForwardWorktree,
} from "@shigomori/contracts/modules/portForward";
import type { PeerCalls } from "@host/ipc/PeerReach";
import { mintHexId } from "@host/lib/hexId";
import {
  type BridgedConn,
  bridgeSocket,
  listenLoopback,
  type PeerChannels,
} from "./bridge";

export type ForwardApi = PeerCalls<typeof forwardContract>;

// Client-side cap on live conns per device, under the host's own
// per-connection channel cap (host/ipc/modules/forward.ts): sized so
// one browser tab's ~6 keepalive sockets plus an HMR websocket fit
// with headroom. Per host process, so this count spans ALL forwards to
// one device, not each forward alone. A conn over the cap would be
// refused there anyway, but only after a full open round trip, so an
// accepted socket over the cap is destroyed immediately instead.
// Exported so the port-forward check's cap scenario tracks this value.
export const MAX_CONNS_PER_DEVICE = 16;

// The changed signal's window: opens and closes arrive in bursts (one
// page load moves ~a dozen conns), and each signal triggers a renderer
// list refetch, so a burst goes out as one signal this long after its
// first member.
const CHANGE_WINDOW_MS = 150;

type Forward = {
  forwardId: string;
  deviceId: string;
  remotePort: number;
  localPort: number;
  // The worktree it was switched on from, the last one to ask for it.
  worktree: PortForwardWorktree | undefined;
  // Holds the listener, the conns and their opens.
  scope: Scope.Closeable;
  // Every accepted socket, for the cap and teardown.
  conns: Set<BridgedConn>;
  // The ones whose far end opened, which is what the summary counts: a
  // dial to a port with nothing behind it never shows as a conn.
  opened: Set<BridgedConn>;
};

export type PortForwardEngine = Effect.Success<
  ReturnType<typeof makePortForwardEngine>
>;

// The changed signal and every forward run in the caller's scope.
export const makePortForwardEngine = Effect.fnUntraced(function* (deps: {
  forwardApiFor: (deviceId: string) => ForwardApi;
  // The peer session's byte channels (bridge.ts PeerChannels).
  channelsFor: (deviceId: string) => PeerChannels;
  onChange?: () => void;
}) {
  const engineScope = yield* Effect.scope;
  // The conns' opens run on the engine's own services, not a caller's.
  const services = yield* Effect.context<never>();
  const forwards = new Map<string, Forward>();
  // A change waiting to go out: one is all a burst needs.
  const changes = yield* Queue.sliding<void>(1);
  const changed = () => void Queue.offerUnsafe(changes, undefined);
  yield* Stream.fromQueue(changes).pipe(
    Stream.groupedWithin(Infinity, CHANGE_WINDOW_MS),
    Stream.runForEach(() => Effect.sync(() => deps.onChange?.())),
    Effect.forkScoped,
  );

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

  function liveConnsTo(deviceId: string): number {
    let count = 0;
    for (const forward of forwards.values()) {
      if (forward.deviceId === deviceId) count += forward.conns.size;
    }
    return count;
  }

  // A start answered by a forward already held, whether found up front
  // or bound by a concurrent twin. A worktree's start claims it (from
  // the account page, or another worktree listing the same port), so
  // the worktree that last asked is the one marked as forwarding.
  function reuse(
    forward: Forward,
    worktree: PortForwardWorktree | undefined,
  ): { forwardId: string; localPort: number } {
    if (worktree !== undefined) {
      forward.worktree = worktree;
      changed();
    }
    return { forwardId: forward.forwardId, localPort: forward.localPort };
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
  const probe = Effect.fnUntraced(function* (
    api: ForwardApi,
    channels: PeerChannels,
    remotePort: number,
  ) {
    const mux = yield* Effect.tryPromise({
      try: () => channels(),
      catch: callFailureOf,
    });
    const channelId = mintHexId();
    const handle = yield* Effect.try({
      try: () =>
        mux.attach(channelId, {
          onData: (_data, consumed) => consumed(),
          onEnd: () => {},
          onReset: () => {},
          onWritable: () => {},
        }),
      catch: callFailureOf,
    });
    yield* api.open({ port: remotePort, channelId }).pipe(
      Effect.catchIf(isForwardConnectFailedError, () => Effect.void),
      Effect.ensuring(Effect.sync(() => handle.reset())),
    );
  });

  // Every step acquires into the forward's scope, which the start
  // closes if it fails or is interrupted.
  const bindForward = Effect.fnUntraced(function* (
    input: {
      deviceId: string;
      remotePort: number;
      localPort?: number;
      worktree?: PortForwardWorktree;
    },
    existing: Forward | undefined,
    scope: Scope.Closeable,
  ) {
    const api = deps.forwardApiFor(input.deviceId);
    const channels = deps.channelsFor(input.deviceId);
    yield* probe(api, channels, input.remotePort);
    // allowHalfOpen: a client FIN must not tear the conn down (the
    // adapter in host/socket/channelStreams.ts ends one direction and
    // keeps the other flowing), but node's default would auto-end the
    // writable side and drop the remote's response.
    const server = createServer({ allowHalfOpen: true });
    const localPort = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => listenLoopback(server, input.localPort ?? 0),
        catch: callFailureOf,
      }),
      () => Effect.sync(() => server.close()),
    );
    // The dedupe scan ran before the probe and the bind, so a
    // concurrent start for the same pair may have bound in the meantime:
    // yield to the twin and release the just-bound listener. The
    // forward being moved is not a twin: it is what the new listener
    // replaces, and only now, with the replacement bound, does it go.
    const twin = findForward(input.deviceId, input.remotePort);
    if (twin !== undefined && twin !== existing) {
      yield* Scope.close(scope, Exit.void);
      return reuse(twin, input.worktree);
    }
    if (existing !== undefined) yield* stopForward(existing.forwardId);
    // The engine closed while this start was under way: nothing of it
    // stays, and the listener went as it was bound.
    if (Predicate.isTagged(engineScope.state, "Closed")) {
      return yield* Effect.interrupt;
    }
    const set = yield* FiberSet.make();
    const run = yield* FiberSet.runtimePromise(set)<never>().pipe(
      Effect.provideContext(services),
    );
    const forward: Forward = {
      forwardId: mintHexId(),
      deviceId: input.deviceId,
      remotePort: input.remotePort,
      localPort,
      worktree: input.worktree ?? existing?.worktree,
      scope,
      conns: new Set(),
      opened: new Set(),
    };
    const handleConnection = (socket: Socket): void => {
      if (liveConnsTo(forward.deviceId) >= MAX_CONNS_PER_DEVICE) {
        socket.destroy();
        return;
      }
      const conn = bridgeSocket(socket, {
        channels,
        open: (channelId) =>
          run(api.open({ port: forward.remotePort, channelId })),
        onOpened: () => {
          forward.opened.add(conn);
          changed();
        },
        onClosed: () => {
          forward.conns.delete(conn);
          if (forward.opened.delete(conn)) changed();
        },
      });
      forward.conns.add(conn);
    };
    server.on("connection", handleConnection);
    // A bound listener errors only in exotic cases, but an unlistened
    // 'error' would take the whole process down.
    server.on("error", () => {});
    // Registered last, so it is the first undone: the conns go before
    // their opens are interrupted and the listener closed.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        forwards.set(forward.forwardId, forward);
        changed();
      }),
      () =>
        Effect.sync(() => {
          forwards.delete(forward.forwardId);
          // destroy deletes only the conn being visited, which Set
          // iteration tolerates.
          for (const conn of forward.conns) conn.destroy();
          changed();
        }),
    );
    return { forwardId: forward.forwardId, localPort };
  });

  const startForward = Effect.fn("PortForwards.startForward")(
    function* (input: {
      deviceId: string;
      remotePort: number;
      localPort?: number;
      worktree?: PortForwardWorktree;
    }) {
      // One forward per (deviceId, remotePort): starting an existing pair
      // returns it unchanged, unless the caller names a different local
      // port, which moves the listener there. The old listener stays up
      // until the new one is bound (bindForward), so a move that fails (port
      // taken, peer gone) leaves the working forward exactly as it was.
      // Idempotent otherwise, the simpler contract for a UI whose start
      // doubles as "make sure this is forwarded".
      const existing = findForward(input.deviceId, input.remotePort);
      if (
        existing !== undefined &&
        (input.localPort === undefined ||
          input.localPort === existing.localPort)
      ) {
        return reuse(existing, input.worktree);
      }
      const scope = yield* Scope.fork(engineScope);
      return yield* bindForward(input, existing, scope).pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    },
  );

  // Idempotent: stopping an unknown or already-stopped forward is a
  // no-op.
  const stopForward = Effect.fn("PortForwards.stopForward")(function* (
    forwardId: string,
  ) {
    const forward = forwards.get(forwardId);
    if (forward === undefined) return;
    yield* Scope.close(forward.scope, Exit.void);
  });

  function listForwards(): PortForwardSummary[] {
    return [...forwards.values()].map((forward) => ({
      forwardId: forward.forwardId,
      deviceId: forward.deviceId,
      remotePort: forward.remotePort,
      localPort: forward.localPort,
      connCount: forward.opened.size,
      worktree: forward.worktree,
    }));
  }

  // Every forward onto a device `keep` refuses: the peer left the
  // account, so its loopback listener would only ever black-hole.
  const stopForwardsTo = Effect.fn("PortForwards.stopForwardsTo")(function* (
    keep: (deviceId: string) => boolean,
  ) {
    const leaving = [...forwards.values()].filter(
      (forward) => !keep(forward.deviceId),
    );
    yield* Effect.forEach(
      leaving,
      (forward) => stopForward(forward.forwardId),
      {
        discard: true,
      },
    );
  });

  return { startForward, stopForward, listForwards, stopForwardsTo };
});
