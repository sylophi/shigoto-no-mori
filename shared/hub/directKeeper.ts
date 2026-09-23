// The direct data plane's supervisor: direct peer
// sessions are DESIRED STATE, and the live presence roster is the
// desired-state input. A session exists because its device is present,
// never because the UI asked for one, so no user action is ever what
// triggers a dial: the keeper dials every rostered peer eagerly the
// moment presence names it, redials forever on the shared backoff
// ladder when the dial fails or an established session dies, and the
// dial cost lands ahead of use instead of on a click. Without this,
// the one connection that carries the user's work would also be the
// only unsupervised one (the hub socket and cloudflared are both
// supervised): a peer whose listener merely blipped stayed dead until
// somebody clicked it.
//
// Retry discipline, same rails as shared/remote/supervisor.ts (whose
// ladder and stable threshold this reuses rather than copying):
// forever-retry with capped backoff for transient failures, a stable
// reset so a healthy session that blips does not inherit a punishing
// delay, and TERMINAL verdicts schedule NOTHING rather than spin.
// Scheduling nothing is what keeps eager dialing from weaponizing the
// host's per-identity failed-auth lockout against ourselves: a refused
// ticket retried on a timer is a lockout feeder, so such a peer waits
// for its roster presence to transition offline to online (its app
// restarted, or our own hub link came back, both of which reset the
// roster diff) -- the "blocked until inputs change" rule with presence
// as the input. Parking is also what keeps eager dialing off peers
// there is structurally nothing to dial ON: a web client serves no
// direct listener by construction, and without a park every desktop
// would redial every open browser tab at the ladder's cap forever.
//
// The mirror of that rule matters just as much: park only on verdicts
// that really are stuck. Being INSIDE the host's lockout window is
// not one of them -- it expires on its own, refusing a connection does
// not extend it, and a park would leave the peer dead long after it
// lifted with no roster transition to unpark on. The host says which
// case it is with a distinct close code (CLOSE_AUTH_LOCKED_OUT), so a
// lockout arrives here as a transient failure and rides the ladder
// out. A park is for a ticket that was read and refused.
//
// The keeper is the ONLY caller that starts a dial (the bridge's
// dialPeer, whose cache makes a re-dial of a live or in-flight peer a
// no-op), so keeper state and the bridge's session cache cannot
// drift: sessions appear via keeper dials, and disappear via the
// transport's self-close (peerDropped below), the roster sweep (which
// also interrupts the peer's fiber), or quit (stop).
//
// One Effect fiber per rostered peer, held in a FiberMap keyed by
// device id: dial, hold until the session drops, sleep one rung, go
// again. Removing a peer from the roster interrupts its fiber, which
// cancels a sleep on the ladder or abandons a dial in flight, so no
// continuation is left to ask whether it is still wanted. stop()
// closes the map: every fiber is interrupted, and a closed FiberMap
// refuses new fibers outright, which is the quit latch.
//
// Pure shared code (no node builtins, no electron), driven headlessly
// by the direct-plane check under a TestClock runtime and a stub dial.
import { Clock, Deferred, Effect, Exit, FiberMap, Scope } from "effect";
import {
  BACKOFF_LADDER_MS,
  ranAtLeast,
  STABLE_CONNECTION_MS,
  defaultSupervisorRuntime,
  superviseLadder,
  type SupervisorRuntime,
} from "@shared/remote/supervisor";
import { isTerminalDialError } from "./directDial";
import { errorMessageOf } from "@shared/errors";

type DirectKeeperDeps = {
  // One dial attempt for one peer: the bridge's dialPeer. Resolving
  // means an established session (or one already cached), rejecting
  // means the attempt failed with the dialer's typed error.
  dial(deviceId: string): Promise<unknown>;
  // The one test seam: where the peers' fibers run. The check passes a
  // ManagedRuntime built on TestClock.layer() and drives the ladder
  // with TestClock.adjust instead of sleeping it out. The ladder and
  // the stable threshold are NOT seams -- they are the shared
  // supervisor constants, and the check asserts against those same
  // constants on purpose.
  runtime?: SupervisorRuntime;
};

export type DirectKeeper = {
  // Feed the desired set: the live roster on every hub transition, and
  // [] whenever our own hub link is down (no roster, no verdicts, and
  // nothing to dial: the broker leg rides the device hub). Peers new to
  // the set dial at once, peers gone from it drop their keeper state
  // (their sessions are the presence sweep's job), peers steadily in it
  // keep whatever schedule they have.
  reconcile(online: readonly string[]): void;
  // An ESTABLISHED session died on its own (the transport's
  // self-close, never an owner-initiated one): schedule the redial,
  // resetting the ladder when the session had proven stable.
  peerDropped(deviceId: string): void;
  // Why there is currently no session for a rostered peer (its last
  // dial failure, cleared the moment a dial succeeds), for the
  // bridge's no-session rejection. Null when none applies.
  unavailableReason(deviceId: string): string | null;
  // Quit: interrupt every peer's fiber and ignore everything after, so
  // a pending retry cannot dial mid-teardown.
  stop(): void;
};

// What the rest of the keeper reads about a peer while its fiber
// runs. The fiber owns it: it is added when the fiber starts and
// removed when the fiber ends, so membership here is exactly "has a
// fiber", which is "was in the last live roster".
type PeerState = {
  lastFailure: string | null;
  // Completed by peerDropped. A fresh one per attempt, made BEFORE the
  // dial, so a drop that lands while the dial's result is still on its
  // way back is not lost.
  dropped: Deferred.Deferred<void>;
};

export function createDirectKeeper(deps: DirectKeeperDeps): DirectKeeper {
  const runtime = deps.runtime ?? defaultSupervisorRuntime;
  const peers = new Map<string, PeerState>();
  // The map's scope is the keeper's lifetime: stop() closes it.
  const scope = Scope.makeUnsafe();
  const fibers = Effect.runSync(
    FiberMap.make<string>().pipe(Scope.provide(scope)),
  );

  // One peer's supervision, from roster entry until it is interrupted.
  // Never fails: every way a dial can end is read below.
  const keepPeer = (deviceId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const state: PeerState = {
        lastFailure: null,
        dropped: Deferred.makeUnsafe<void>(),
      };
      peers.set(deviceId, state);
      // One dial, and the hold on the session it made until it drops.
      // The ladder climbs on every backoff and resets only on a stable
      // session's drop; roster re-entry (a new fiber) starts at the
      // bottom.
      const attempt = Effect.gen(function* () {
        state.dropped = Deferred.makeUnsafe<void>();
        const dialed = yield* Effect.tryPromise({
          try: () => deps.dial(deviceId),
          catch: (error) => error,
        }).pipe(
          Effect.as({ ok: true as const }),
          Effect.catch((error) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        );
        if (dialed.ok) {
          const connectedAt = yield* Clock.currentTimeMillis;
          if (state.lastFailure !== null) {
            console.info(`[direct] session to ${deviceId} established`);
          }
          state.lastFailure = null;
          // The ladder is NOT reset here: only a drop after a STABLE run
          // resets it, so a connect-then-die flapper keeps climbing
          // instead of hammering at the bottom rung.
          yield* Deferred.await(state.dropped);
          return {
            stable: yield* ranAtLeast(connectedAt, STABLE_CONNECTION_MS),
          };
        }
        const message = errorMessageOf(dialed.error);
        // One line per DISTINCT reason, not per rung: the ladder
        // redials forever, and a reason unchanged since the last
        // attempt says nothing new. This is the only place a failed
        // dial is logged at all (the renderer learns of it only when
        // it asks, through the no-session rejection), so without it a
        // peer that never connects leaves no trace in the log.
        if (message !== state.lastFailure) {
          console.warn(`[direct] dial to ${deviceId} failed: ${message}`);
        }
        state.lastFailure = message;
        if (isTerminalDialError(dialed.error)) {
          // Park. Redialing cannot change it and WOULD feed the
          // host's failed-auth lockout, so the fiber waits with its
          // reason recorded and nothing on a timer: this peer's next
          // dial comes from its roster re-entry (see the header),
          // which starts a fresh fiber. Waiting rather than ending
          // keeps the peer in the map, so a steady roster does not
          // restart it.
          return yield* Effect.never;
        }
        return { stable: false };
      });
      yield* superviseLadder(BACKOFF_LADDER_MS, attempt);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          peers.delete(deviceId);
        }),
      ),
    );

  return {
    reconcile(online) {
      const live = new Set(online);
      const departed = [...peers.keys()].filter((id) => !live.has(id));
      runtime.runFork(
        Effect.gen(function* () {
          // The peer left the roster (or our own link went down and
          // the caller fed []). Interrupting its fiber cancels its
          // schedule and forgets it. Closing its sessions is the
          // presence sweep's job, and the gate that keeps sessions
          // alive through OUR OWN hub outage lives there too
          // (directPresence.ts).
          for (const deviceId of departed) {
            yield* FiberMap.remove(fibers, deviceId);
          }
          // New to the roster: dial at once. A peer already in the map
          // keeps its fiber (onlyIfMissing), so a steady roster leaves
          // a backoff in progress alone. The bridge's cache makes a
          // fresh dial a no-op resolve for a session that survived a
          // device hub blip, so a reconnect's full-roster diff costs
          // nothing for peers still connected. After stop() the map is
          // closed and run adds nothing.
          for (const deviceId of live) {
            yield* FiberMap.run(fibers, deviceId, keepPeer(deviceId), {
              onlyIfMissing: true,
            });
          }
        }),
      );
    },

    peerDropped(deviceId) {
      // A live roster entry is the whole condition: the bridge fires
      // this only for a session it had ESTABLISHED and that closed on
      // its own, and a peer already swept from the roster (or stopped)
      // has no entry. Completing an already completed signal is a
      // no-op, so a redundant call cannot stack redials.
      const state = peers.get(deviceId);
      if (state !== undefined) Deferred.doneUnsafe(state.dropped, Effect.void);
    },

    unavailableReason(deviceId) {
      return peers.get(deviceId)?.lastFailure ?? null;
    },

    stop() {
      runtime.runFork(Scope.close(scope, Exit.void));
    },
  };
}
