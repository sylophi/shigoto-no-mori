// Client half of the direct data plane (v2 step 10, slice A): dial a
// peer's direct listener, brokered over the relay. The dialer asks the
// peer for connect info (direct:connectInfo, a read served pre-grant)
// over a short-lived relay peer session, then dials the returned
// candidates, each a complete URL (ws:// interface candidates, the
// wss:// tunnel endpoint, v2 step 10 slice B) with its own single-use
// ticket. The result is the SAME DeviceConnection shape the LAN client
// resolves, so everything downstream (the bridge cache, sync,
// port-forward) stays transport agnostic.
//
// DIAL STRATEGY: one overall deadline around the WHOLE attempt (broker
// leg included: a wedged peer that never answers connectInfo must not
// hang the bridge's cached promise forever). All candidate SOCKETS
// open concurrently, but the HELLOS are serialized: at most one hello
// is in flight, the next candidate's hello goes out only after the
// previous handshake failed, and losers whose hello was never sent are
// closed pre-auth. Serialization is what makes a multi-candidate dial
// safe against the host's one-authed-socket-per-device supersede rule:
// with concurrent hellos the SLOWER candidate's hello would land after
// the winner was cached and supersede-kill the fresh session, so the
// first invoke on it would reject. An abandoned pre-auth socket is
// harmless to the host (no ticket spent, nothing superseded), so a
// junk candidate opening first (Docker bridges, VPN interfaces) costs
// only its own open, never the race.
//
// BLOCKED VERDICTS: what makes a verdict terminal is the CLOSE CODE,
// and it has to be, because this side has no other honest source. The
// host refuses a bad ticket with CLOSE_AUTH_FAILED (blocked) and
// refuses a locked-out client with CLOSE_AUTH_LOCKED_OUT (retryable),
// and only the host can tell those apart: the lockout fires before any
// hello is read, keys on client IP, and benches whoever dials next
// even with a perfect ticket.
//
// This file used to make that call itself, gating terminality on
// whether the candidate's hello "was actually sent". That predicate
// cannot carry the weight. helloSent records that WE WROTE a hello,
// never that the host READ one -- and against a connection-time
// lockout close the write almost always wins the race, since the pump
// hellos on a microtask off the open event while the close arrives an
// event later. So the single-candidate lockout (a tunnel-only peer:
// the common case) looked hello-sent, read as a refused ticket, and
// parked the peer with no timer, while the lockout expired 30s later
// with no roster transition to unpark on. The close code fixes that at
// the source.
//
// The helloSent gate stays, with a narrower job: FAIL FAST. A blocked
// verdict on a candidate we helloed aborts the whole attempt at once
// instead of waiting out a blackhole candidate's deadline. It is also
// the conservative belt against a peer whose close code cannot be
// trusted (an old build predating CLOSE_AUTH_LOCKED_OUT): such a
// blocked-but-never-helloed error retires just that candidate, and if
// it is the LAST one the exhaustion reject converts it to its
// transient form (same message, same close code, no blocked verdict)
// rather than letting a stale-shaped lockout park the peer. Both
// halves err toward retrying, which is the safe direction: a redial
// costs one refused connection, a wrong park costs the peer until the
// roster round trips.
//
// NO LISTENER AT ALL: a peer whose relay binding serves no broker
// handler (a web client, "a refuse-all host" by construction) answers
// every connectInfo req with the no-handler shape. That is a
// STRUCTURAL fact about the platform on the other end, not a failed
// call, so it is mapped onto NoDialableCandidateError rather than left
// as the generic invoke rejection it arrives as: eager supervision
// would otherwise redial every browser tab in the roster on the
// ladder's cap forever. Genuine broker failures (relay blip, peer
// mid-boot, invoke timeout) stay transient, which is why the typed
// RelayNoHandlerError from the link -- not a message match here -- is
// the discriminator.
//
// ONE ATTEMPT, NO POLICY: connectDirect is a single dial under a
// single deadline, and a failure rejects typed with no retry and no
// memo. Retry lives in exactly one place, the presence-driven keeper
// (shared/relay/directKeeper.ts), which paces redials on the shared
// backoff ladder and parks on the terminal verdicts
// (isTerminalDialError below). Data is direct or nothing (v2 step 10,
// slice C): there is no relay fallback behind these failures, the
// typed rejection IS the outcome the caller surfaces. A second retry
// owner here (the old per-peer failure memo) would fight the keeper's
// ladder, so this file deliberately carries none.
//
// Pure browser-global-plus-shared code: no node builtins, no electron,
// so the direct-plane check drives it headlessly under node (whose
// global WebSocket serves connectDevice, as in the LAN client checks).
import {
  ALL_DIRECT_CANDIDATE_KINDS,
  candidateUrlMatchesKind,
  MAX_DIRECT_CANDIDATES,
  type DirectCandidate,
  type DirectCandidateKind,
  type DirectConnectInfoInput,
  DirectConnectInfoSchema,
} from "@shared/ipc/modules/direct";
import {
  openDevice,
  RemoteConnectError,
  type DeviceConnection,
  type PendingDeviceConnection,
} from "@shared/ipc/socket/wsClientTransport";
import { HELLO_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import { RelayNoHandlerError, type RelayBrokerSession } from "./link";

// The LAN DeviceConnection shape verbatim, so everything downstream of
// a direct dial (the bridge cache, sync, port-forward) is transport
// agnostic.
export type PeerConnection = DeviceConnection;

export type ConnectPeerOpts = {
  // Called once when an ESTABLISHED direct connection dies on its own
  // (socket teardown, roster drop). Never fires for an owner initiated
  // close, and never for a failed connect.
  onClose?: () => void;
};

// Candidates dialed at once: the shared advertising cap for interface
// addresses plus the one tunnel candidate, enforced here too so a
// hostile or buggy connectInfo answer cannot fan out an unbounded dial
// burst.
const MAX_DIAL_CANDIDATES = MAX_DIRECT_CANDIDATES + 1;

// Thrown when nothing about this pairing is dialable AS A MATTER OF
// STRUCTURE, so only the peer's own state changing can change the
// answer. Two shapes reach it:
//
//   - the peer advertises candidates but none is a kind THIS platform
//     can dial (an old host ignoring the caller's declared
//     dialableKinds and answering lan-only to a browser page). A
//     kind-aware host filters to the caller's kinds itself and answers
//     available:false when nothing survives, so this arises only
//     across version skew.
//   - the peer serves no broker handler at all (a web client), so it
//     has no direct listener to advertise and never will while it is
//     that platform.
//
// Typed so a caller can tell "there is nothing here to dial" apart
// from an ordinary dial failure. The detail says which shape it was,
// since the keeper surfaces this message as the peer's unavailable
// reason.
export class NoDialableCandidateError extends Error {
  constructor(
    deviceId: string,
    detail = "offers no candidate this platform can dial",
  ) {
    super(`peer ${deviceId} ${detail}`);
    this.name = "NoDialableCandidateError";
  }
}

// True when redialing cannot change the outcome until the peer's own
// state changes: a blocked verdict whose ticket was provably presented
// and refused (or the wrong machine answered), or a structural
// nothing-this-platform-can-dial answer (no dialable kind, or no
// direct listener served at all). The keeper PARKS on these
// instead of retrying on the ladder, which is what keeps eager
// supervision from feeding the host's per-identity failed-auth lockout
// a steady diet of refused tickets: a parked peer redials only when
// presence says its state changed (offline to online), never on a
// timer. Every other failure (unreachable, deadline, no listener yet)
// is transient and retries forever.
export function isTerminalDialError(error: unknown): boolean {
  return (
    (error instanceof RemoteConnectError && error.blocked) ||
    error instanceof NoDialableCandidateError
  );
}

export type DirectDialerDeps = {
  // Opens the relay broker session for the connectInfo exchange. The
  // NARROWED session type is the point (v2 step 10, slice C): it
  // exposes one typed broker invoke plus close, so this dep cannot be
  // used to move contract traffic over the relay even by accident. The
  // dialer runs only on a bridge cache miss, so no cached session for
  // this device exists to be superseded, and the temporary session is
  // closed before the dial result settles either way.
  connectBroker(deviceId: string): Promise<RelayBrokerSession>;
  // This device's identity, carried in the direct hello alongside the
  // ticket.
  localDeviceId: string;
  localAppVersion: string;
  // Every push received on a direct connection, tagged with the peer's
  // deviceId, so the owner can feed the same peerPush path the relay
  // feeds.
  onAnyPush?: (deviceId: string, channel: string, payload: unknown) => void;
  // The candidate kinds THIS platform can dial (v2 step 10, slice B),
  // declared to the host in the connectInfo input so it only mints
  // tickets this caller can spend, and applied again at candidate
  // selection for hosts that predate the input field: a candidate of
  // any other kind is dropped before the race, its ticket simply
  // unspent. The web bridge declares ["tunnel"] (a browser page cannot
  // dial ws:// under https, mixed content), the app takes the default
  // and races everything.
  dialableKinds?: ReadonlyArray<DirectCandidateKind>;
  // Test seams. Real callers take the defaults and real time.
  deadlineMs?: number;
  now?: () => number;
};

export type DirectDialer = {
  connectDirect(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
};

// The exhaustion reject's one conversion (see BLOCKED VERDICTS in the
// header). A current host names its lockout on the wire
// (CLOSE_AUTH_LOCKED_OUT), so nothing blocked should reach here at
// all: the hello-sent case rejects the attempt early, and a lockout is
// not blocked in the first place. This is the SKEW belt. An old peer
// still refuses a locked-out connection with CLOSE_AUTH_FAILED, and if
// that candidate is the last to retire, its error is what the attempt
// would reject with -- a temporary bench wearing a permanent verdict's
// clothes, which the keeper answers by parking with no timer while the
// lockout quietly expires. The message and close code survive so the
// reason stays truthful. Only the blocked semantics are dropped.
function asTransientVerdict(error: unknown): unknown {
  if (error instanceof RemoteConnectError && error.blocked) {
    return new RemoteConnectError(error.message, error.code, false);
  }
  return error;
}

// A leg abandoned by the deadline may still resolve later. Its
// session must not linger half-owned, so close it on arrival.
function closeWhenSettled(promise: Promise<{ close(): void }>): void {
  promise
    .then((session) => {
      session.close();
    })
    .catch(() => {
      // Already failed on its own.
    });
}

export function createDirectDialer(deps: DirectDialerDeps): DirectDialer {
  // The overall attempt deadline. HELLO_TIMEOUT_MS is the wire's one
  // honest "a handshake should have happened by now" value, and each
  // leg below (the relay hello, the connectInfo invoke, every
  // candidate handshake) individually stays under it.
  const deadlineMs = deps.deadlineMs ?? HELLO_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const dialableKinds = new Set<DirectCandidateKind>(
    deps.dialableKinds ?? ALL_DIRECT_CANDIDATE_KINDS,
  );

  // Open every candidate's socket at once, then hello them one at a
  // time in socket-open order (see the file header for why hellos are
  // serialized). The first successful handshake wins and every other
  // socket is abandoned pre-auth. `deadline` rejects the race when the
  // overall budget runs out, and a handshake that resolves after
  // settlement is closed rather than leaked.
  function raceCandidates(
    deviceId: string,
    opts: ConnectPeerOpts | undefined,
    candidates: DirectCandidate[],
    remainingMs: number,
    deadline: Promise<never>,
  ): Promise<PeerConnection> {
    return new Promise<PeerConnection>((resolve, reject) => {
      let done = false;
      let winnerIndex = -1;
      let outstanding = candidates.length;
      let lastError: unknown = new Error(
        `no dialable candidate for peer ${deviceId}`,
      );
      // Indexes whose socket is open and whose hello is queued behind
      // the one in flight. Null helloIndex means the pump may send the
      // next hello.
      const ready: number[] = [];
      let helloIndex: number | null = null;

      const handles: PendingDeviceConnection[] = candidates.map(
        (candidate, index) =>
          openDevice({
            url: candidate.url,
            // This candidate's own single-use ticket rides the
            // existing hello token field.
            token: candidate.ticket,
            appVersion: deps.localAppVersion,
            localDeviceId: deps.localDeviceId,
            // Identity pin: a welcome from any other deviceId fails
            // the handshake and closes the socket.
            expectedDeviceId: deviceId,
            // Only the winning candidate's lifecycle belongs to the
            // caller: a losing or abandoned socket dropping must not
            // evict the winner from the bridge cache.
            onClose: () => {
              if (winnerIndex === index) opts?.onClose?.();
            },
            onAnyPush: (channel, payload) => {
              if (winnerIndex === index) {
                deps.onAnyPush?.(deviceId, channel, payload);
              }
            },
            // The hello timer starts at open and covers the TCP open
            // and any time spent queued behind another hello, so every
            // candidate self-settles within the overall deadline.
            helloTimeoutMs: remainingMs,
          }),
      );

      const settleAll = (): void => {
        for (const handle of handles) handle.abandon();
      };

      // One settlement per candidate: either its whenOpen rejected
      // (never queued) or its authenticate rejected (its hello turn
      // failed, or its socket died while queued).
      const failCandidate = (error: unknown, helloWasSent: boolean): void => {
        if (done) return;
        if (
          helloWasSent &&
          error instanceof RemoteConnectError &&
          error.blocked
        ) {
          // The ticket was refused, or the wrong machine answered.
          // Terminal for the whole attempt: redialing cannot change
          // it, so the caller learns at once instead of waiting out
          // the deadline. `blocked` is the load-bearing half (the
          // host's close code, which distinguishes a refused
          // credential from its temporary lockout). helloWasSent is
          // the conservative belt, keeping a peer whose code cannot be
          // trusted from aborting the rest of the race.
          done = true;
          settleAll();
          reject(error);
          return;
        }
        lastError = error;
        outstanding -= 1;
        if (outstanding === 0) {
          done = true;
          // Every candidate retired without a hello-sent refusal, so a
          // blocked verdict among them came from a peer whose close
          // code cannot be trusted, and is surfaced as transient.
          reject(asTransientVerdict(lastError));
        }
      };

      const pump = (): void => {
        if (done || helloIndex !== null) return;
        const index = ready.shift();
        if (index === undefined) return;
        helloIndex = index;
        handles[index].authenticate().then(
          (connection) => {
            if (done) {
              connection.close();
              return;
            }
            done = true;
            winnerIndex = index;
            // The losers never sent a hello (serialization), so the
            // abandon is a pre-auth close the host never even logs.
            handles.forEach((handle, i) => {
              if (i !== index) handle.abandon();
            });
            resolve(connection);
          },
          (error: unknown) => {
            helloIndex = null;
            failCandidate(error, handles[index].helloSent());
            pump();
          },
        );
      };

      handles.forEach((handle, index) => {
        handle.whenOpen.then(
          () => {
            if (done) return;
            ready.push(index);
            pump();
          },
          (error: unknown) => {
            failCandidate(error, false);
          },
        );
      });

      deadline.catch((error: unknown) => {
        if (done) return;
        done = true;
        settleAll();
        reject(error);
      });
    });
  }

  // One whole attempt under the deadline: broker leg, then the
  // candidate race.
  async function runDial(
    deviceId: string,
    opts: ConnectPeerOpts | undefined,
    deadline: Promise<never>,
    deadlineAt: number,
  ): Promise<PeerConnection> {
    // Ask the peer how to dial it. The relay session is the BROKER
    // SESSION only (one typed invoke, see RelayBrokerSession),
    // temporary by design and closed below (which also tells the host
    // to drop its session, the bye frame): on success the direct
    // socket replaces it, on failure the whole attempt rejects and
    // nothing keeps riding the relay. When the deadline abandons a
    // still-pending hello, the late session is closed on arrival
    // instead of leaking.
    const brokerPromise = deps.connectBroker(deviceId);
    let broker: RelayBrokerSession;
    try {
      broker = await Promise.race([brokerPromise, deadline]);
    } catch (error) {
      closeWhenSettled(brokerPromise);
      throw error;
    }
    let info;
    try {
      // The invoke itself is raced too: a wedged peer that never
      // answers is exactly what the deadline exists for, and the
      // close in the finally rejects the abandoned invoke so nothing
      // stays pending. The input declares this platform's dialable
      // kinds so the host mints no ticket we cannot spend. An old host
      // parses void and ignores it, hence the belt below.
      const input: DirectConnectInfoInput = {
        dialableKinds: [...dialableKinds],
      };
      info = DirectConnectInfoSchema.parse(
        await Promise.race([broker.brokerInvoke(input), deadline]),
      );
    } catch (error) {
      // The peer serves no broker handler: it is a refuse-all host (a
      // web client) with no direct listener to advertise, not a call
      // that failed. Terminal, so the keeper parks it and waits for
      // the roster round trip that would follow the peer becoming a
      // different kind of thing. Every other rejection here (relay
      // blip, peer mid-boot, the deadline) stays exactly as thrown and
      // therefore transient.
      if (error instanceof RelayNoHandlerError) {
        throw new NoDialableCandidateError(
          deviceId,
          "serves no direct listener",
        );
      }
      throw error;
    } finally {
      broker.close();
    }
    const candidates = info.available ? (info.candidates ?? []) : [];
    if (candidates.length === 0) {
      // A peer whose listener is down answers available:false, and so
      // does a kind-aware peer with nothing THIS caller can dial. The
      // peer is unreachable for data RIGHT NOW, which is not the same
      // as structurally undialable: its listener may be mid-boot, or
      // the directConnections opt-out may be flipped back on without
      // any roster transition to unpark on. So this stays a plain,
      // transient error and the keeper keeps it on the ladder. (A peer
      // that serves no handler at all rejects the invoke above and
      // never reaches here.)
      throw new Error(`peer ${deviceId} offers no direct listener`);
    }
    // Platform capability re-applied at candidate selection (the belt
    // for hosts that predate the dialableKinds input), plus the
    // kind-to-scheme invariant, so a candidate that somehow bypassed
    // the schema is skipped rather than dialed. The fan-out cap keeps
    // a hostile or buggy answer from dialing an unbounded burst.
    const dialable = candidates
      .filter(
        (candidate) =>
          dialableKinds.has(candidate.kind) &&
          candidateUrlMatchesKind(candidate.kind, candidate.url),
      )
      .slice(0, MAX_DIAL_CANDIDATES);
    if (dialable.length === 0) {
      // The peer is direct-capable, just not from THIS platform (an
      // old host answering lan-only to a browser page). The typed
      // error is what lets the keeper treat this DIFFERENTLY from an
      // ordinary dial failure: it is terminal (isTerminalDialError
      // below), so the keeper schedules nothing and waits for the
      // peer's roster round trip, while a plain unreachable retries on
      // the ladder.
      throw new NoDialableCandidateError(deviceId);
    }
    return raceCandidates(
      deviceId,
      opts,
      dialable,
      Math.max(1, deadlineAt - now()),
      deadline,
    );
  }

  async function connectDirect(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection> {
    const at = now();
    // One deadline over the ENTIRE attempt, so the bridge's cached
    // promise always settles: without it a wedged connectInfo would
    // park every consumer of this peer behind a promise nothing ever
    // rejects.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(
          new Error(
            `direct dial to ${deviceId} exceeded its ${deadlineMs}ms deadline`,
          ),
        );
      }, deadlineMs);
    });
    try {
      return await runDial(deviceId, opts, deadline, at + deadlineMs);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  return { connectDirect };
}
