// Client half of the direct data plane (v2 step 10, slice A): dial a
// peer's direct listener, brokered over the relay. The dialer asks the
// peer for connect info (direct:connectInfo, a read served pre-grant)
// over a short-lived relay peer session, then dials the returned
// candidate addresses, each with its own single-use ticket. The result
// is the SAME DeviceConnection shape connectPeer resolves, so
// everything downstream (the bridge cache, sync, port-forward) stays
// transport agnostic.
//
// DIAL STRATEGY: one overall deadline around the WHOLE attempt (broker
// leg included: a wedged peer that never answers connectInfo must not
// hang the bridge's cached promise forever), then all candidates dialed
// CONCURRENTLY. Per-candidate tickets make the race safe: a candidate
// that reaches the host but loses burns only its own ticket. The first
// successful handshake wins and the losers are closed, so a junk
// candidate enumerating first (Docker bridges, VPN interfaces) costs
// nothing, where a sequential walk made direct fail deterministically
// on exactly the multi-interface machines it targets. A blocked
// verdict (a refused ticket, a wrong-identity welcome) is terminal for
// the whole attempt: redialing cannot change it, so the caller falls
// back to the relay at once.
//
// FAILURE MEMO: a failed dial is remembered per peer, and within the
// window connectDirect throws immediately so the bridge falls back to
// the relay without paying the dial cost again for a peer that is not
// direct-reachable. The memo clears when that peer transitions
// offline to online in the roster (notePresence, wired from the
// owner's presence path), or after the ticket TTL, whichever first.
//
// Pure browser-global-plus-shared code: no node builtins, no electron,
// so the direct-plane check drives it headlessly under node (whose
// global WebSocket serves connectDevice, as in the LAN client checks).
import {
  DIRECT_TICKET_TTL_MS,
  DirectConnectInfoSchema,
} from "@shared/ipc/modules/direct";
import {
  connectDevice,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import { HELLO_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import type { ConnectPeerOpts, PeerConnection } from "./link";

// Candidates dialed at once, mirroring the host-side advertising cap
// (host/direct/addresses.ts) and enforced here too so a hostile or
// buggy connectInfo answer cannot fan out an unbounded dial burst.
const MAX_CANDIDATES = 6;

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

// Bracket IPv6 literals so they survive URL parsing.
function wsUrlOf(address: string, port: number): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `ws://${host}:${port}`;
}

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

  // Peer deviceId to the timestamp its failure memo expires, pruned
  // lazily on each dial so the map stays bounded by the peers dialed
  // within one window.
  const failedDials = new Map<string, number>();
  // The roster seen by the last notePresence call, so the memo clears
  // exactly on an offline to online transition.
  let lastOnline = new Set<string>();

  // Dial every candidate at once. First successful handshake wins and
  // the losers are closed. A blocked verdict rejects the whole race,
  // any other failure just retires that candidate. `deadline` rejects
  // the race when the overall budget runs out, and a candidate that
  // resolves after settlement is closed rather than leaked.
  function raceCandidates(
    deviceId: string,
    opts: ConnectPeerOpts | undefined,
    info: { port: number; addresses: string[]; tickets: string[] },
    remainingMs: number,
    deadline: Promise<never>,
  ): Promise<PeerConnection> {
    return new Promise<PeerConnection>((resolve, reject) => {
      let done = false;
      let winnerIndex = -1;
      let outstanding = info.addresses.length;
      let lastError: unknown = new Error(
        `no dialable candidate for peer ${deviceId}`,
      );
      deadline.catch((error: unknown) => {
        if (done) return;
        done = true;
        reject(error);
      });
      info.addresses.forEach((address, index) => {
        connectDevice({
          url: wsUrlOf(address, info.port),
          // This candidate's own single-use ticket rides the existing
          // hello token field.
          token: info.tickets[index],
          appVersion: deps.localAppVersion,
          localDeviceId: deps.localDeviceId,
          // Identity pin: a welcome from any other deviceId fails the
          // handshake and closes the socket.
          expectedDeviceId: deviceId,
          // Only the winning candidate's lifecycle belongs to the
          // caller: a losing socket dropping (closed by us, or
          // superseded by the winner host-side) must not evict the
          // winner from the bridge cache.
          onClose: () => {
            if (winnerIndex === index) opts?.onClose?.();
          },
          onAnyPush: (channel, payload) => {
            if (winnerIndex === index) {
              deps.onAnyPush?.(deviceId, channel, payload);
            }
          },
          // The hello timer starts at dial and covers the TCP open
          // too, so every candidate self-settles within the overall
          // deadline.
          helloTimeoutMs: remainingMs,
        }).then(
          (connection) => {
            if (done) {
              connection.close();
              return;
            }
            done = true;
            winnerIndex = index;
            resolve(connection);
          },
          (error: unknown) => {
            if (done) return;
            if (error instanceof RemoteConnectError && error.blocked) {
              // The ticket was presented and refused, or the wrong
              // machine answered. Terminal for the whole attempt:
              // dialing more candidates only racks up auth failures
              // against the host's per-IP lockout.
              done = true;
              reject(error);
              return;
            }
            lastError = error;
            outstanding -= 1;
            if (outstanding === 0) {
              done = true;
              reject(lastError);
            }
          },
        );
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
      // stays pending.
      info = DirectConnectInfoSchema.parse(
        await Promise.race([
          relayPeer.transport.invoke("direct:connectInfo", undefined),
          deadline,
        ]),
      );
    } finally {
      relayPeer.close();
    }
    if (
      !info.available ||
      info.port === undefined ||
      info.addresses === undefined ||
      info.tickets === undefined ||
      info.addresses.length === 0 ||
      info.tickets.length !== info.addresses.length
    ) {
      // An old peer answers "No handler registered" (thrown above) and
      // a new-but-not-listening peer answers available:false. Either
      // way the caller falls back to the relay.
      throw new Error(`peer ${deviceId} offers no direct listener`);
    }
    return raceCandidates(
      deviceId,
      opts,
      {
        port: info.port,
        addresses: info.addresses.slice(0, MAX_CANDIDATES),
        tickets: info.tickets.slice(0, MAX_CANDIDATES),
      },
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
      failedDials.set(deviceId, now() + failureTtlMs);
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  return {
    connectDirect,
    notePresence(online) {
      for (const id of online) {
        if (!lastOnline.has(id)) failedDials.delete(id);
      }
      lastOnline = new Set(online);
    },
  };
}
