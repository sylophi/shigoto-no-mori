// In-memory store of the direct data plane's connect tickets.
// connectInfo (connectInfo.ts) mints one set per ask over the device hub
// (one ticket per candidate address). The direct listener checks one
// as a dialer's socket opens (shared/remote/sealedSocket.ts) and spends
// it on that socket's hello, once the handshake has proved the dialer.
// Tickets are short-lived, single-use bearer strings bound to the peer
// deviceId they were minted for, so a leaked ticket is useless to any
// other device and goes stale in a minute. Nothing is persisted: a
// restart simply forgets pending tickets and the next connectInfo mints
// fresh ones.
//
// Bookkeeping is PER CONNECTION of a peer: the asker names the
// connection it is dialing for (a web device's tabs each dial their
// own), and each mint replaces that connection's whole pending set, so
// a connection looping connectInfo only ever invalidates its own
// tickets, and sibling tabs asking at once each keep theirs. A device
// holds at most MAX_DEVICE_CONNECTIONS sets, its oldest giving way. The
// global cap is a refusing backstop, never an eviction of another
// peer's in-flight tickets, which would refuse their dials.
//
// A ticket this store issued and has since let go is remembered a
// while (RETIRED_TICKETS), so a dial presenting it reads as stale and
// not as a guess: only a ticket never issued counts toward the
// listener's lockout.
//
// This file must stay Electron free (pnpm test host-boundary).
import {
  type DirectCandidateKind,
  DIRECT_TICKET_TTL_MS,
} from "@shigomori/contracts/modules/direct";
import { MAX_DEVICE_CONNECTIONS } from "@shigomori/contracts/hubProtocol";
import { mintHexId } from "@host/lib/hexId";
import { STALE_TICKET } from "@shared/remote/sealedSocket";

// The distinguishing prefix, following the hub worker's smrt_/smdc_
// convention (hub/src/ticket.ts): smpt_ for a peer-to-peer connect
// ticket. Purely cosmetic for logs and debugging, never parsed.
export const DIRECT_TICKET_PREFIX = "smpt_";

// Total pending tickets held at once, across every peer. Per-connection
// replacement and the per-device cap already bound each peer, so this
// only guards against many distinct peers minting concurrently. At the cap a mint REFUSES (the
// host answers available:false) rather than evicting another peer's
// pending set.
const MAX_PENDING_TICKETS = 256;

// How many let-go tickets are remembered as issued, the oldest
// forgotten first: a few full turns of the pending cap.
const RETIRED_TICKETS = 4 * MAX_PENDING_TICKETS;

// Who a ticket set was minted for: the peer device, and the connection
// of it that asked (shared/hub/directDial.ts mints one per dial).
export type TicketPeer = {
  readonly deviceId: string;
  readonly connectionId: string;
};

export type ConnectTicketStore = {
  // Mints one ticket per candidate KIND, in order, all bound to the
  // named peer and REPLACING any tickets that connection still had
  // pending. Returns null when the global backstop cap would be
  // exceeded, which connectInfo surfaces as available:false.
  mint(
    peer: TicketPeer,
    kinds: readonly DirectCandidateKind[],
  ): string[] | null;
  // The peer device a pending ticket was minted for, spending nothing:
  // what lets a socket open. STALE_TICKET for one this store issued that
  // opens nothing now, null for one it never issued. A socket that
  // fails its handshake leaves the ticket for the dialer it belongs to.
  //
  // `arrivedAs` is the path the connection came in on, and must equal
  // the kind the ticket was minted for, so a ticket handed out for one
  // path opens nothing on another, and stays pending for the path it
  // belongs to.
  check(
    ticket: string,
    arrivedAs: DirectCandidateKind,
  ): string | null | typeof STALE_TICKET;
  // Spends the ticket, answering the peer device it was minted for, or
  // null when it is not pending (spent by another socket meanwhile,
  // expired, or dropped). Single use: a ticket links one socket, the
  // one whose hello spends it first.
  consume(ticket: string, arrivedAs: DirectCandidateKind): string | null;
  // Whether the device's last `runs` sets in a row, whichever of its
  // connections asked, were minted with a ticket of `kind` and none of
  // its tickets reached this host since: dials that reached nothing
  // (a dialer asks again, under a fresh connection id, after one
  // fails). True once per run of such failures: a ticket of any of its
  // sets reaching a hello ends the run, so several tabs of one web
  // device share the count, and any tab linking resets it.
  claimUndialed(
    deviceId: string,
    kind: DirectCandidateKind,
    runs: number,
  ): boolean;
  // Drops the pending tickets of every device not in `deviceIds`, the
  // account's live roster: a device removed from the account spends
  // nothing it was handed before.
  keepDevices(deviceIds: readonly string[]): void;
  // Drops every pending ticket. For an account change: a ticket is
  // minted for a peer of the account this host is on, and a peer of
  // the account it just left must not be able to spend one on the
  // listener the next account gets (the tunnel candidate is the same
  // stable hostname either side of the switch).
  clear(): void;
};

export type ConnectTicketStoreOpts = {
  // Test seams. Real callers take the defaults and real time.
  ttlMs?: number;
  now?: () => number;
};

// The key of one connection's pending set.
const setKey = (peer: TicketPeer) => `${peer.deviceId}\n${peer.connectionId}`;

export function createConnectTicketStore(
  opts: ConnectTicketStoreOpts = {},
): ConnectTicketStore {
  const ttlMs = opts.ttlMs ?? DIRECT_TICKET_TTL_MS;
  // oxlint-disable-next-line shigomori/no-wall-clock -- a ticket expires by real time, so a sleep expires it too; tests pass their own
  const now = opts.now ?? Date.now;
  // The lookup consume needs, ticket string to its binding.
  const pending = new Map<
    string,
    {
      peerDeviceId: string;
      set: string;
      expiresAt: number;
      kind: DirectCandidateKind;
    }
  >();
  // Each connection's pending set, in minting order, which mint's
  // replacement and the per-device cap run on.
  const sets = new Map<string, { deviceId: string; tickets: Set<string> }>();
  // Each device's asks since a ticket of its last reached a hello: the
  // kinds its latest set was minted with, how many sets before it held
  // each kind, and the kinds this run already answered true for.
  const asks = new Map<
    string,
    {
      latest: ReadonlySet<DirectCandidateKind>;
      before: Map<DirectCandidateKind, number>;
      claimed: Set<DirectCandidateKind>;
    }
  >();
  // The tickets let go, oldest first.
  const retired = new Set<string>();

  function retire(ticket: string): void {
    pending.delete(ticket);
    retired.add(ticket);
    for (const oldest of retired) {
      if (retired.size <= RETIRED_TICKETS) break;
      retired.delete(oldest);
    }
  }

  // Removes one ticket and keeps its set in step.
  function forget(ticket: string, set: string): void {
    retire(ticket);
    const entry = sets.get(set);
    if (entry === undefined) return;
    entry.tickets.delete(ticket);
    if (entry.tickets.size === 0) sets.delete(set);
  }

  function dropSet(set: string): void {
    const entry = sets.get(set);
    if (entry === undefined) return;
    sets.delete(set);
    for (const ticket of entry.tickets) retire(ticket);
  }

  // Lazy sweep on mint: absolute TTL stands (consume checks it), this
  // only keeps a connection that minted once and never dialed from
  // leaving entries behind past their expiry.
  function sweepExpired(): void {
    const cutoff = now();
    for (const [ticket, entry] of pending) {
      if (entry.expiresAt > cutoff) continue;
      forget(ticket, entry.set);
    }
  }

  return {
    clear() {
      for (const ticket of pending.keys()) retire(ticket);
      sets.clear();
      asks.clear();
    },
    mint(peer, kinds) {
      sweepExpired();
      // Replacement first: a fresh connectInfo invalidates the same
      // connection's previous candidate-set (only its freshest dial
      // should hold live tickets), and its slots do not count against
      // it.
      const key = setKey(peer);
      dropSet(key);
      // The device's oldest sets give way past its cap, so one device
      // asking under ever new connection ids holds a bounded share.
      const own = [...sets].filter(
        ([, entry]) => entry.deviceId === peer.deviceId,
      );
      for (const [oldest] of own.slice(
        0,
        Math.max(0, own.length - MAX_DEVICE_CONNECTIONS + 1),
      )) {
        dropSet(oldest);
      }
      if (pending.size + kinds.length > MAX_PENDING_TICKETS) return null;
      const expiresAt = now() + ttlMs;
      const tickets: string[] = [];
      const set = new Set<string>();
      for (const kind of kinds) {
        // The random half reuses the host's opaque-id minter so the
        // random-secret recipe lives in one place.
        const ticket = `${DIRECT_TICKET_PREFIX}${mintHexId()}`;
        pending.set(ticket, {
          peerDeviceId: peer.deviceId,
          set: key,
          expiresAt,
          kind,
        });
        set.add(ticket);
        tickets.push(ticket);
      }
      if (set.size > 0)
        sets.set(key, { deviceId: peer.deviceId, tickets: set });
      const asked = asks.get(peer.deviceId);
      const before = new Map<DirectCandidateKind, number>();
      for (const kind of asked?.latest ?? []) {
        before.set(kind, (asked?.before.get(kind) ?? 0) + 1);
      }
      asks.set(peer.deviceId, {
        latest: new Set(kinds),
        before,
        claimed: asked?.claimed ?? new Set(),
      });
      return tickets;
    },

    check(ticket, arrivedAs) {
      const entry = pending.get(ticket);
      if (entry === undefined) {
        return retired.has(ticket) ? STALE_TICKET : null;
      }
      return entry.kind !== arrivedAs || entry.expiresAt <= now()
        ? STALE_TICKET
        : entry.peerDeviceId;
    },

    claimUndialed(deviceId, kind, runs) {
      const asked = asks.get(deviceId);
      if (asked === undefined || asked.claimed.has(kind)) return false;
      const undialed =
        (asked.before.get(kind) ?? 0) + (asked.latest.has(kind) ? 1 : 0);
      if (undialed < runs) return false;
      asked.claimed.add(kind);
      return true;
    },

    keepDevices(deviceIds) {
      const keep = new Set(deviceIds);
      for (const [key, entry] of sets) {
        if (!keep.has(entry.deviceId)) dropSet(key);
      }
      for (const deviceId of asks.keys()) {
        if (!keep.has(deviceId)) asks.delete(deviceId);
      }
    },

    consume(ticket, arrivedAs) {
      const entry = pending.get(ticket);
      if (entry === undefined || entry.kind !== arrivedAs) return null;
      asks.delete(entry.peerDeviceId);
      forget(ticket, entry.set);
      return entry.expiresAt > now() ? entry.peerDeviceId : null;
    },
  };
}
