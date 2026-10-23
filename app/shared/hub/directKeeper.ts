// Direct sessions are desired state, with the live roster as input: the
// keeper dials every rostered peer as presence names it and redials on
// the shared ladder (shared/remote/supervisor.ts) when a dial fails or
// a session dies, so a peer whose listener blipped comes back without a
// click.
//
// A refused ticket and the host's lockout ride the same ladder: the
// lockout expires on its own, and a connection the lockout refuses
// doesn't extend it. A peer with no listener (a web client) parks until
// it re-enters the roster (its app restarted, or our own hub link came
// back), or every desktop would redial every open tab forever.
//
// The keeper is the only caller of the bridge's dialPeer, so its state
// and the session cache can't drift. Pure shared code (no node builtins, no
// electron).
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import {
  BACKOFF_LADDER_MS,
  makeWake,
  restartSchedule,
  type Wake,
} from "@shared/remote/supervisor";
import { NoDialableCandidateError } from "./directDial";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { elapsedMillisUnsafe } from "@shigomori/engine/elapsed";
import { log } from "@shared/log";

type DirectKeeperDeps = {
  // One dial attempt for one peer: the bridge's dialPeer. Succeeding
  // means an established session (or one already cached), failing
  // means the attempt failed with the dialer's typed error.
  dial(deviceId: string): Effect.Effect<unknown, unknown>;
};

export type DirectKeeper = {
  // The desired set: the live roster, or [] while our own hub link is
  // down.
  reconcile(online: readonly string[]): void;
  // An established session died on its own (the transport's
  // self-close, never an owner-initiated one): schedule the redial,
  // resetting the ladder when the session had proven stable.
  peerDropped(deviceId: string): void;
  // Why there is currently no session for a rostered peer (its last
  // dial failure, cleared the moment a dial succeeds), for the
  // bridge's no-session rejection. Null when none applies.
  unavailableReason(deviceId: string): string | null;
  // The network is back, the machine awake or a tab back: every peer
  // waiting out the ladder dials now.
  dialNow(): void;
};

type PeerState = {
  loop: Fiber.Fiber<never> | null;
  // The current attempt's session drop, armed before its dial, so a
  // drop reported however early ends the session's wait.
  dropped: Deferred.Deferred<void> | null;
  lastFailure: string | null;
  // Failed dials since the last session (or since the peer came online).
  failures: number;
  // Since when the live session's uptime counts (monotonic), null
  // while there is none.
  upSince: number | null;
  // Cuts its wait on the shared ladder short.
  wake: Wake;
};

// The keeper, for the length of the scope it is made in: the peers'
// loops run in it (on its Clock), and its close is the quit's latch:
// every loop ends and everything after is ignored, so a pending retry
// cannot dial mid-teardown.
export const make = (
  deps: DirectKeeperDeps,
): Effect.Effect<DirectKeeper, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    const clock = yield* Clock.Clock;

    // Membership here is "was in the last live roster": reconcile prunes
    // and seeds it, so an offline-to-online transition always lands on a
    // fresh loop (the ladder's bottom, dialing at once) without a second
    // roster copy.
    const states = new Map<string, PeerState>();
    // Set as the scope closes, before the loops end. Only reconcile reads
    // it, since only reconcile seeds new loops.
    let stopped = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopped = true;
        states.clear();
      }),
    );

    // One dial and, when it lands, the session until it drops. Answers
    // how long the session stayed up, which the restart schedule reads:
    // a failed dial counts as 0, and only a drop after a stable run
    // resets the ladder, so a connect-then-die flapper keeps climbing
    // instead of hammering at the bottom rung.
    const attempt = (deviceId: string, state: PeerState) =>
      Effect.gen(function* () {
        const dropped = yield* Deferred.make<void>();
        state.dropped = dropped;
        const dialed = yield* Effect.result(deps.dial(deviceId));
        if (Result.isFailure(dialed)) {
          const error = dialed.failure;
          const message = errorMessageOf(error);
          state.failures += 1;
          // Once per distinct reason: the ladder redials forever, and
          // this is the only log of a failed dial.
          if (message !== state.lastFailure) {
            log.warn(
              `[direct] dial to ${deviceId} failed (attempt ${state.failures}): ${message}`,
            );
          }
          state.lastFailure = message;
          // A peer with no listener (a web client) has nothing to dial
          // while it is one, so the loop parks until its roster re-entry
          // (see the header).
          if (error instanceof NoDialableCandidateError) {
            return yield* Effect.never;
          }
          return 0;
        }
        state.upSince = elapsedMillisUnsafe(clock);
        if (state.failures > 0) {
          log.info(
            `[direct] session to ${deviceId} established after ${state.failures} failed attempts`,
          );
        }
        state.lastFailure = null;
        state.failures = 0;
        yield* Deferred.await(dropped);
        const uptime =
          state.upSince === null
            ? 0
            : elapsedMillisUnsafe(clock) - state.upSince;
        state.upSince = null;
        return uptime;
      });

    const keep = (deviceId: string) => {
      const state: PeerState = {
        loop: null,
        dropped: null,
        lastFailure: null,
        failures: 0,
        upSince: null,
        wake: makeWake(),
      };
      state.loop = run(
        attempt(deviceId, state).pipe(
          Effect.repeat(
            restartSchedule(BACKOFF_LADDER_MS).pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.as(state.wake.wait(duration), Duration.zero),
              ),
            ),
          ),
          Effect.andThen(Effect.never),
        ),
      );
      return state;
    };

    const forget = (state: PeerState) => {
      if (state.loop !== null) run(Fiber.interrupt(state.loop));
    };

    return {
      reconcile(online) {
        // A roster feed arriving after the close would re-add peers and
        // dial them into a teardown.
        if (stopped) return;
        const live = new Set(online);
        for (const [deviceId, state] of states) {
          if (!live.has(deviceId)) {
            // Its sessions are the presence sweep's (directPresence.ts).
            forget(state);
            states.delete(deviceId);
          }
        }
        for (const deviceId of live) {
          if (states.has(deviceId)) continue;
          // New: dial at once (a no-op while the cache holds a session).
          states.set(deviceId, keep(deviceId));
        }
      },

      peerDropped(deviceId) {
        // The bridge fires this only for a session it had established and
        // that closed on its own. A peer already swept from the roster
        // (or stopped) has no entry.
        const state = states.get(deviceId);
        if (state?.dropped == null) return;
        const { dropped } = state;
        state.dropped = null;
        run(Deferred.succeed(dropped, undefined));
      },

      unavailableReason(deviceId) {
        return states.get(deviceId)?.lastFailure ?? null;
      },

      dialNow() {
        for (const state of states.values()) state.wake.now();
      },
    } satisfies DirectKeeper;
  });
