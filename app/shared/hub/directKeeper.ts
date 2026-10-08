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
// ladder and restart schedule this reuses rather than copying):
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
// would redial every open browser tab at the ladder's cap forever. A
// peer on a version this one no longer speaks to parks the same way,
// until it updates and its relaunch round-trips the roster.
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
// also deletes the keeper's entry), or quit (stop's latch).
//
// Pure shared code (no node builtins, no electron), driven headlessly
// by the direct-plane check on a TestClock with a stub dial.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { BACKOFF_LADDER_MS, restartSchedule } from "@shared/remote/supervisor";
import { isTerminalDialError } from "./directDial";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { log } from "@shared/log";

type DirectKeeperDeps = {
  // One dial attempt for one peer: the bridge's dialPeer. Resolving
  // means an established session (or one already cached), rejecting
  // means the attempt failed with the dialer's typed error.
  dial(deviceId: string): Promise<unknown>;
  // What the peers' loops run in: the app's, or the check's with a
  // TestClock, which drives the ladder instead of sleeping it out. The
  // ladder and the stable threshold are NOT seams -- they are the
  // shared supervisor constants, and the check asserts against those
  // same constants on purpose.
  context?: Context.Context<never>;
};

export type DirectKeeper = {
  // Feed the desired set: the live roster on every hub transition, and
  // [] whenever our own hub link is down (no roster, no verdicts, and
  // nothing to dial: the connectInfo ask rides the device hub). Peers new to
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
  // Quit latch: end every peer's loop and ignore everything after, so a
  // pending retry cannot dial mid-teardown.
  stop(): void;
};

type PeerState = {
  loop: Fiber.Fiber<never> | null;
  // The current attempt's session drop, armed before its dial, so a
  // drop reported however early ends the session's wait.
  dropped: Deferred.Deferred<void> | null;
  lastFailure: string | null;
};

export function createDirectKeeper(deps: DirectKeeperDeps): DirectKeeper {
  const run = Effect.runForkWith(deps.context ?? Context.empty());

  // Membership here IS "was in the last live roster": reconcile prunes
  // and seeds it, so an offline-to-online transition always lands on a
  // fresh loop (the ladder's bottom, dialing at once) without a second
  // roster copy.
  const states = new Map<string, PeerState>();
  // Set by stop(), which also ends every loop. Only reconcile reads it,
  // since only reconcile seeds new loops.
  let stopped = false;

  // One dial and, when it lands, the session until it drops. Answers
  // how long the session stayed up, which the restart schedule reads:
  // a failed dial counts as 0, and only a drop after a STABLE run
  // resets the ladder, so a connect-then-die flapper keeps climbing
  // instead of hammering at the bottom rung.
  const attempt = (deviceId: string, state: PeerState) =>
    Effect.gen(function* () {
      const dropped = yield* Deferred.make<void>();
      state.dropped = dropped;
      const dialed = yield* Effect.callback<Result.Result<unknown, unknown>>(
        (resume) => {
          const dialing = Promise.resolve().then(() => deps.dial(deviceId));
          dialing.then(
            (session) => resume(Effect.succeed(Result.succeed(session))),
            (error: unknown) => resume(Effect.succeed(Result.fail(error))),
          );
        },
      );
      if (Result.isFailure(dialed)) {
        const error = dialed.failure;
        const message = errorMessageOf(error);
        // One line per DISTINCT reason, not per rung: the ladder
        // redials forever, and a reason unchanged since the last
        // attempt says nothing new. This is the only place a failed
        // dial is logged at all (the renderer learns of it only when
        // it asks, through the no-session rejection), so without it a
        // peer that never connects leaves no trace in the log.
        if (message !== state.lastFailure) {
          log.warn(`[direct] dial to ${deviceId} failed: ${message}`);
        }
        state.lastFailure = message;
        // Redialing cannot change a terminal verdict and WOULD feed the
        // host's failed-auth lockout, so the loop parks: this peer's
        // next dial comes from its roster re-entry (see the header),
        // which starts a fresh loop.
        if (isTerminalDialError(error)) return yield* Effect.never;
        return 0;
      }
      const connectedAt = yield* Clock.currentTimeMillis;
      if (state.lastFailure !== null) {
        log.info(`[direct] session to ${deviceId} established`);
      }
      state.lastFailure = null;
      yield* Deferred.await(dropped);
      return (yield* Clock.currentTimeMillis) - connectedAt;
    });

  const keep = (deviceId: string) => {
    const state: PeerState = { loop: null, dropped: null, lastFailure: null };
    state.loop = run(
      attempt(deviceId, state).pipe(
        Effect.repeat(restartSchedule(BACKOFF_LADDER_MS)),
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
      // The ONE place the latch does real work: reconcile SEEDS the
      // map, so a roster feed arriving after stop() would re-add peers
      // and dial them into a teardown.
      if (stopped) return;
      const live = new Set(online);
      for (const [deviceId, state] of states) {
        if (!live.has(deviceId)) {
          // The peer left the roster (or our own link went down and
          // the caller fed []). End its loop and forget it. Closing
          // its sessions is the presence sweep's job, and the gate that
          // keeps sessions alive through OUR OWN hub outage lives there
          // too (directPresence.ts).
          forget(state);
          states.delete(deviceId);
        }
      }
      for (const deviceId of live) {
        if (states.has(deviceId)) continue;
        // New to the roster: dial at once. The bridge's cache makes
        // this a no-op resolve for a session that survived a device hub
        // blip, so a reconnect's full-roster diff costs nothing for
        // peers still connected.
        states.set(deviceId, keep(deviceId));
      }
    },

    peerDropped(deviceId) {
      // The bridge fires this only for a session it had ESTABLISHED and
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

    stop() {
      stopped = true;
      for (const state of states.values()) forget(state);
      states.clear();
    },
  };
}
