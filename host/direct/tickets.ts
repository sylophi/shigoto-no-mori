// In-memory store of the direct data plane's connect tickets (v2 step
// 10, slice A). direct:connectInfo mints one set per calling peer over
// the hub (one ticket per candidate address), and the direct
// listener's hello consumes them. Tickets are short-lived, single-use
// bearer strings bound to the peer deviceId they were minted for, so a
// leaked ticket is useless to any other device and goes stale in a
// minute. Nothing is persisted: a restart simply forgets pending
// tickets and the next connectInfo mints fresh ones.
//
// Bookkeeping is PER PEER: each mint call replaces that peer's whole
// pending set, so a peer looping connectInfo only ever invalidates its
// own tickets and holds at most one candidate-set at a time
// (self-limiting). The global cap is a refusing backstop, never an
// eviction of another peer's in-flight tickets: evicting would feed
// the listener's per-IP auth lockout against innocent peers whose
// dials then present a vanished ticket.
//
// This file must stay Electron free (host:check).
import { DIRECT_TICKET_TTL_MS } from "@shared/ipc/modules/direct";
import { mintHexId } from "@host/lib/idleRegistry";

// The distinguishing prefix, following the hub worker's smrt_/smdc_
// convention (hub/src/ticket.ts): smpt_ for a peer-to-peer connect
// ticket. Purely cosmetic for logs and debugging, never parsed.
export const DIRECT_TICKET_PREFIX = "smpt_";

// Total pending tickets held at once, across every peer. Per-peer
// replacement already bounds each peer to one candidate-set (at most
// the candidate cap of tickets), so this only guards against many
// distinct peers minting concurrently. At the cap a mint REFUSES (the
// broker answers available:false) rather than evicting another peer's
// pending set.
const MAX_PENDING_TICKETS = 256;

export type ConnectTicketStore = {
  // Mints `count` tickets bound to the named peer deviceId, REPLACING
  // any tickets that peer still had pending. Returns null when the
  // global backstop cap would be exceeded, which the broker surfaces
  // as available:false.
  mint(peerDeviceId: string, count: number): string[] | null;
  // Consumes a presented ticket. The entry is deleted on FIRST
  // presentation regardless of outcome (single use), then the verdict
  // requires: the ticket existed, is unexpired, and its bound peer
  // deviceId equals the claimed one. 128 random bits looked up by map
  // key make a constant-time comparison unnecessary: an attacker
  // cannot iterate toward a stored key through timing on a hash map.
  consume(ticket: string, peerDeviceId: string): boolean;
};

export type ConnectTicketStoreOpts = {
  // Test seams. Real callers take the defaults and real time.
  ttlMs?: number;
  now?: () => number;
};

export function createConnectTicketStore(
  opts: ConnectTicketStoreOpts = {},
): ConnectTicketStore {
  const ttlMs = opts.ttlMs ?? DIRECT_TICKET_TTL_MS;
  const now = opts.now ?? Date.now;
  // The lookup consume needs, ticket string to its binding.
  const pending = new Map<
    string,
    { peerDeviceId: string; expiresAt: number }
  >();
  // The per-peer index mint's replacement runs on, so one peer's mint
  // can only ever delete that peer's own tickets.
  const byPeer = new Map<string, Set<string>>();

  function dropPeerSet(peerDeviceId: string): void {
    const tickets = byPeer.get(peerDeviceId);
    if (tickets === undefined) return;
    byPeer.delete(peerDeviceId);
    for (const ticket of tickets) pending.delete(ticket);
  }

  // Lazy sweep on mint: absolute TTL stands (consume checks it), this
  // only keeps a peer that minted once and never dialed from leaving
  // entries behind past their expiry.
  function sweepExpired(): void {
    const cutoff = now();
    for (const [ticket, entry] of pending) {
      if (entry.expiresAt > cutoff) continue;
      pending.delete(ticket);
      const set = byPeer.get(entry.peerDeviceId);
      if (set !== undefined) {
        set.delete(ticket);
        if (set.size === 0) byPeer.delete(entry.peerDeviceId);
      }
    }
  }

  return {
    mint(peerDeviceId, count) {
      sweepExpired();
      // Replacement first: a fresh connectInfo invalidates the same
      // peer's previous candidate-set (only the freshest dial should
      // hold live tickets), and its slots do not count against it.
      dropPeerSet(peerDeviceId);
      if (pending.size + count > MAX_PENDING_TICKETS) return null;
      const expiresAt = now() + ttlMs;
      const tickets: string[] = [];
      const set = new Set<string>();
      for (let i = 0; i < count; i += 1) {
        // The random half reuses the host's opaque-id minter so the
        // random-secret recipe lives in one place.
        const ticket = `${DIRECT_TICKET_PREFIX}${mintHexId()}`;
        pending.set(ticket, { peerDeviceId, expiresAt });
        set.add(ticket);
        tickets.push(ticket);
      }
      if (set.size > 0) byPeer.set(peerDeviceId, set);
      return tickets;
    },

    consume(ticket, peerDeviceId) {
      const entry = pending.get(ticket);
      // Single use: gone the moment it is presented, whatever the
      // verdict, so a replay after a failed hello fails too.
      pending.delete(ticket);
      if (entry === undefined) return false;
      const set = byPeer.get(entry.peerDeviceId);
      if (set !== undefined) {
        set.delete(ticket);
        if (set.size === 0) byPeer.delete(entry.peerDeviceId);
      }
      if (entry.expiresAt <= now()) return false;
      return entry.peerDeviceId === peerDeviceId;
    },
  };
}
