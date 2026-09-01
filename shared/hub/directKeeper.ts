// The direct data plane's supervisor (v2 step 11): direct peer
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
// ladder, stable threshold and clock this reuses rather than copying):
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
// also deletes the keeper's entry), or quit (stop's latch).
//
// Pure shared code (no node builtins, no electron), driven headlessly
// by the direct-plane check with a fake clock and a stub dial.
import {
  BACKOFF_LADDER_MS,
  backoffDelayMs,
  defaultSupervisorClock,
  STABLE_CONNECTION_MS,
  type SupervisorClock,
  type SupervisorTimer,
} from "@shared/remote/supervisor";
import { isTerminalDialError } from "./directDial";
import { errorMessageOf } from "@shared/errors";

export type DirectKeeperDeps = {
  // One dial attempt for one peer: the bridge's dialPeer. Resolving
  // means an established session (or one already cached), rejecting
  // means the attempt failed with the dialer's typed error.
  dial(deviceId: string): Promise<unknown>;
  // The one test seam: the check drives the ladder with a fake clock
  // instead of sleeping it out. The ladder and the stable threshold
  // are NOT seams -- they are the shared supervisor constants, and the
  // check asserts against those same constants on purpose.
  clock?: SupervisorClock;
};

export type DirectKeeper = {
  // Feed the desired set: the live roster on every hub transition,
  // and [] whenever our own hub link is down (no roster, no
  // verdicts, and nothing to dial: the broker leg rides the hub).
  // Peers new to the set dial at once, peers gone from it drop their
  // keeper state (their sessions are the presence sweep's job), peers
  // steadily in it keep whatever schedule they have.
  reconcile(online: readonly string[]): void;
  // An ESTABLISHED session died on its own (the transport's
  // self-close, never an owner-initiated one): schedule the redial,
  // resetting the ladder when the session had proven stable.
  peerDropped(deviceId: string): void;
  // Why there is currently no session for a rostered peer (its last
  // dial failure, cleared the moment a dial succeeds), for the
  // bridge's no-session rejection. Null when none applies.
  unavailableReason(deviceId: string): string | null;
  // Quit latch: cancel every timer and ignore everything after, so a
  // pending retry cannot dial mid-teardown.
  stop(): void;
};

type PeerState = {
  // Ladder position for the current failure streak, supervisor-style:
  // advanced on every scheduled backoff, reset only by a stable
  // session's drop or the peer's roster re-entry (a fresh state).
  attempt: number;
  // When the live session was established, by the injected clock, so a
  // drop can measure stability.
  connectedAt: number;
  timer: SupervisorTimer | null;
  lastFailure: string | null;
};

export function createDirectKeeper(deps: DirectKeeperDeps): DirectKeeper {
  const clock = deps.clock ?? defaultSupervisorClock;

  // Membership here IS "was in the last live roster": reconcile prunes
  // and seeds it, so an offline-to-online transition always lands on a
  // fresh state (attempt 0, dialing at once) without a second roster
  // copy.
  const states = new Map<string, PeerState>();
  // Set by stop(), which also CLEARS states. Only reconcile reads it:
  // every other path is already guarded by the state-identity check
  // below, which a cleared map fails on its own. See stop().
  let stopped = false;

  // The one liveness question every async continuation asks: is this
  // still the state the map holds for this peer? A continuation
  // landing after the peer left the roster (state deleted or
  // replaced), or after stop() cleared the map, must change nothing.
  function isCurrent(deviceId: string, state: PeerState): boolean {
    return states.get(deviceId) === state;
  }

  function clearTimer(state: PeerState): void {
    if (state.timer !== null) {
      clock.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function dialNow(deviceId: string, state: PeerState): void {
    deps.dial(deviceId).then(
      () => {
        if (!isCurrent(deviceId, state)) return;
        state.connectedAt = clock.now();
        if (state.lastFailure !== null) {
          console.info(`[direct] session to ${deviceId} established`);
        }
        state.lastFailure = null;
        // attempt is NOT reset here: only a drop after a STABLE run
        // resets the ladder (peerDropped), so a connect-then-die
        // flapper keeps climbing instead of hammering at the bottom
        // rung.
      },
      (error: unknown) => {
        if (!isCurrent(deviceId, state)) return;
        const message = errorMessageOf(error);
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
        if (isTerminalDialError(error)) {
          // Redialing cannot change it and WOULD feed the host's
          // failed-auth lockout, so schedule nothing: this peer's next
          // dial comes from its roster re-entry (see the header),
          // which seeds a fresh state.
          return;
        }
        scheduleRedial(deviceId, state);
      },
    );
  }

  // The one backoff rule: delay from the current rung, then advance,
  // exactly the supervisor's scheduleBackoff.
  function scheduleRedial(deviceId: string, state: PeerState): void {
    clearTimer(state);
    const delayMs = backoffDelayMs(BACKOFF_LADDER_MS, state.attempt);
    state.attempt += 1;
    state.timer = clock.setTimeout(() => {
      state.timer = null;
      if (!isCurrent(deviceId, state)) return;
      dialNow(deviceId, state);
    }, delayMs);
  }

  return {
    reconcile(online) {
      // The ONE place the latch does real work: reconcile SEEDS the
      // map, so a roster feed arriving after stop() would re-add peers
      // and dial them into a teardown. Every other path only ever
      // reads an existing entry, which stop() already deleted.
      if (stopped) return;
      const live = new Set(online);
      for (const [deviceId, state] of states) {
        if (!live.has(deviceId)) {
          // The peer left the roster (or our own link went down and
          // the caller fed []). Cancel its schedule and forget it.
          // Closing its sessions is the presence sweep's job, and the
          // gate that keeps sessions alive through OUR OWN hub
          // outage lives there too (directPresence.ts).
          clearTimer(state);
          states.delete(deviceId);
        }
      }
      for (const deviceId of live) {
        if (states.has(deviceId)) continue;
        // New to the roster: dial at once. The bridge's cache makes
        // this a no-op resolve for a session that survived a hub
        // blip, so a reconnect's full-roster diff costs nothing for
        // peers still connected.
        const state: PeerState = {
          attempt: 0,
          connectedAt: 0,
          timer: null,
          lastFailure: null,
        };
        states.set(deviceId, state);
        dialNow(deviceId, state);
      }
    },

    peerDropped(deviceId) {
      // A live roster entry is the whole condition: the bridge fires
      // this only for a session it had ESTABLISHED and that closed on
      // its own, a peer already swept from the roster (or stopped) has
      // no entry, and scheduleRedial clears whatever timer the entry
      // held first, so a redundant call cannot stack schedules.
      const state = states.get(deviceId);
      if (state === undefined) return;
      if (clock.now() - state.connectedAt >= STABLE_CONNECTION_MS) {
        state.attempt = 0;
      }
      scheduleRedial(deviceId, state);
    },

    unavailableReason(deviceId) {
      return states.get(deviceId)?.lastFailure ?? null;
    },

    stop() {
      stopped = true;
      for (const state of states.values()) clearTimer(state);
      states.clear();
    },
  };
}
