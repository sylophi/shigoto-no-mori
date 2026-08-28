// Client half of the direct data plane (v2 step 10, slice A): dial a
// peer's direct listener, brokered over the relay. The dialer asks the
// peer for connect info (direct:connectInfo, a read served pre-grant)
// over a short-lived relay peer session, then dials the returned
// candidates, each a complete URL (ws:// interface candidates, the
// wss:// tunnel endpoint, v2 step 10 slice B) with its own single-use
// ticket. The result is the SAME DeviceConnection shape connectPeer
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
// BLOCKED VERDICTS: a refused ticket or a wrong-identity welcome is
// terminal for the whole attempt ONLY when that candidate's hello was
// actually sent (the ticket provably presented): redialing cannot
// change it, so the caller falls back to the relay at once. A
// connection-TIME auth close whose hello never went out (the host's
// per-identity lockout refusing the connection) proves nothing about
// our tickets and just retires that one candidate, so a lockout on one
// path cannot abort healthy candidates.
//
// FAILURE MEMO: a failed dial is remembered per peer, and within the
// window connectDirect throws immediately so the bridge falls back to
// the relay without paying the dial cost again for a peer that is not
// direct-reachable. The memo clears when that peer transitions
// offline to online in the roster (notePresence, wired from the
// owner's presence path), or after the ticket TTL, whichever first.
// A STRUCTURAL verdict (NoDialableCandidateError: the peer advertised
// candidates but none of a kind this platform can dial) has no TTL at
// all: time cannot change what kinds a peer offers, so the memo holds
// until the peer's next offline-to-online transition.
//
// Pure browser-global-plus-shared code: no node builtins, no electron,
// so the direct-plane check drives it headlessly under node (whose
// global WebSocket serves connectDevice, as in the LAN client checks).
import {
  ALL_DIRECT_CANDIDATE_KINDS,
  candidateUrlMatchesKind,
  DIRECT_TICKET_TTL_MS,
  MAX_DIRECT_CANDIDATES,
  type DirectCandidate,
  type DirectCandidateKind,
  type DirectConnectInfoInput,
  DirectConnectInfoSchema,
} from "@shared/ipc/modules/direct";
import {
  openDevice,
  RemoteConnectError,
  type PendingDeviceConnection,
} from "@shared/ipc/socket/wsClientTransport";
import { HELLO_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import type { ConnectPeerOpts, PeerConnection } from "./link";

// Candidates dialed at once: the shared advertising cap for interface
// addresses plus the one tunnel candidate, enforced here too so a
// hostile or buggy connectInfo answer cannot fan out an unbounded dial
// burst.
const MAX_DIAL_CANDIDATES = MAX_DIRECT_CANDIDATES + 1;

// Thrown when the peer advertises candidates but none of them is a
// kind THIS platform can dial (an old host ignoring the caller's
// declared dialableKinds and answering lan-only to a browser page).
// Typed so a caller can tell "the peer is direct-capable but not from
// here" apart from an ordinary dial failure, and structural for the
// memo above. A kind-aware host filters to the caller's kinds itself
// and answers available:false when nothing survives, so this arises
// only across version skew.
export class NoDialableCandidateError extends Error {
  constructor(deviceId: string) {
    super(`peer ${deviceId} offers no candidate this platform can dial`);
    this.name = "NoDialableCandidateError";
  }
}

export type DirectDialerDeps = {
  // Opens a relay peer session for the connectInfo exchange. The
  // dialer runs only on a bridge cache miss, so no cached session for
  // this device exists to be superseded, and the temporary session is
  // closed before the dial result settles either way.
  connectRelayPeer(deviceId: string): Promise<PeerConnection>;
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
  failureTtlMs?: number;
  now?: () => number;
};

export type DirectDialer = {
  connectDirect(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
  // Feed the latest live roster so a peer coming back online clears
  // its failure memo (its listener likely just came back too).
  notePresence(online: readonly string[]): void;
};

// A leg abandoned by the deadline may still resolve later. Its
// connection must not linger half-owned, so close it on arrival.
function closeWhenSettled(promise: Promise<PeerConnection>): void {
  promise
    .then((connection) => {
      connection.close();
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
  const failureTtlMs = deps.failureTtlMs ?? DIRECT_TICKET_TTL_MS;
  const now = deps.now ?? Date.now;
  const dialableKinds = new Set<DirectCandidateKind>(
    deps.dialableKinds ?? ALL_DIRECT_CANDIDATE_KINDS,
  );

  // Peer deviceId to the timestamp its failure memo expires, pruned
  // lazily on each dial so the map stays bounded by the peers dialed
  // within one window.
  const failedDials = new Map<string, number>();
  // Peers whose last verdict was structural (nothing dialable from
  // this platform). No expiry: cleared only by that peer's
  // offline-to-online transition, so a browser does not pay two relay
  // round trips per minute forever re-learning that a peer has no
  // tunnel.
  const structuralFailures = new Set<string>();
  // The roster seen by the last notePresence call, so the memo clears
  // exactly on an offline to online transition.
  let lastOnline = new Set<string>();

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
          // The ticket was presented and refused, or the wrong machine
          // answered. Terminal for the whole attempt: redialing cannot
          // change it, so the caller falls back to the relay at once.
          // Pre-hello rejections never take this branch, so a lockout
          // or stale route on one candidate cannot abort the rest.
          done = true;
          settleAll();
          reject(error);
          return;
        }
        lastError = error;
        outstanding -= 1;
        if (outstanding === 0) {
          done = true;
          reject(lastError);
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
    // Ask the peer how to dial it. The relay session is temporary and
    // closed below (which also tells the host to drop its session, the
    // bye frame): on success the direct socket replaces it, on failure
    // the caller's relay fallback opens a fresh one with the right
    // close wiring. When the deadline abandons a still-pending hello,
    // the late session is closed on arrival instead of leaking.
    const relayPeerPromise = deps.connectRelayPeer(deviceId);
    let relayPeer: PeerConnection;
    try {
      relayPeer = await Promise.race([relayPeerPromise, deadline]);
    } catch (error) {
      closeWhenSettled(relayPeerPromise);
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
        await Promise.race([
          relayPeer.transport.invoke("direct:connectInfo", input),
          deadline,
        ]),
      );
    } finally {
      relayPeer.close();
    }
    const candidates = info.available ? (info.candidates ?? []) : [];
    if (candidates.length === 0) {
      // An old peer answers "No handler registered" (thrown above), a
      // new-but-not-listening peer answers available:false, and so
      // does a kind-aware peer with nothing THIS caller can dial.
      // Either way the caller falls back to the relay.
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
      // old host answering lan-only to a browser page). The typed,
      // structural error keeps the outcome distinguishable while the
      // caller falls back to the relay all the same.
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
    for (const [id, expiresAt] of failedDials) {
      if (expiresAt <= at) failedDials.delete(id);
    }
    if (structuralFailures.has(deviceId)) {
      throw new NoDialableCandidateError(deviceId);
    }
    if (failedDials.has(deviceId)) {
      throw new Error(
        `direct dial to ${deviceId} failed recently, deferring to the relay`,
      );
    }
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
    } catch (error) {
      if (error instanceof NoDialableCandidateError) {
        structuralFailures.add(deviceId);
      } else {
        failedDials.set(deviceId, now() + failureTtlMs);
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  return {
    connectDirect,
    notePresence(online) {
      for (const id of online) {
        if (!lastOnline.has(id)) {
          failedDials.delete(id);
          structuralFailures.delete(id);
        }
      }
      lastOnline = new Set(online);
    },
  };
}
