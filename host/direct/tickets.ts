// In-memory store of the direct data plane's connect tickets (v2 step
// 10, slice A). direct:connectInfo mints one set per calling peer over
// the device hub (one ticket per candidate address), and the direct
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
// This file must stay Electron free (pnpm test host-boundary).
import {
  type DirectCandidateKind,
  DIRECT_TICKET_TTL_MS,
} from "@shared/ipc/modules/direct";
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
  // Mints one ticket per candidate KIND, in order, all bound to the
  // named peer deviceId and REPLACING any tickets that peer still had
  // pending. Returns null when the global backstop cap would be
  // exceeded, which the broker surfaces as available:false.
  mint(
    peerDeviceId: string,
    kinds: readonly DirectCandidateKind[],
  ): string[] | null;
  // Consumes the pending ticket the dialer proved possession of and
  // hands it back, so the caller can compute the host's half of the
  // proof. Null when none matches. The ticket never arrives (see
  // shared/ipc/socket/proof.ts), so the caller's predicate is tried
  // against this peer's few pending tickets in turn.
  //
  // `arrivedAs` is the path the connection came in on, and must equal
  // the kind the ticket was minted for. That stops a RELAY: a machine
  // squatting an advertised LAN address could shuttle the nonces and
  // proofs through to the real listener over the public tunnel without
  // ever holding the ticket. A relay within one kind needs an attacker
  // on that network already, and only TLS on the LAN candidate stops it.
  consumeProven(
    peerDeviceId: string,
    arrivedAs: DirectCandidateKind,
    matches: (ticket: string) => Promise<boolean>,
  ): Promise<string | null>;
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
    { peerDeviceId: string; expiresAt: number; kind: DirectCandidateKind }
  >();
  // The per-peer index mint's replacement runs on, so one peer's mint
  // can only ever delete that peer's own tickets.
  const byPeer = new Map<string, Set<string>>();

  // Removes one ticket and keeps the per-peer index in step.
  function forget(ticket: string, peerDeviceId: string): void {
    pending.delete(ticket);
    const set = byPeer.get(peerDeviceId);
    if (set === undefined) return;
    set.delete(ticket);
    if (set.size === 0) byPeer.delete(peerDeviceId);
  }

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
      forget(ticket, entry.peerDeviceId);
    }
  }

  return {
    mint(peerDeviceId, kinds) {
      sweepExpired();
      // Replacement first: a fresh connectInfo invalidates the same
      // peer's previous candidate-set (only the freshest dial should
      // hold live tickets), and its slots do not count against it.
      dropPeerSet(peerDeviceId);
      if (pending.size + kinds.length > MAX_PENDING_TICKETS) return null;
      const expiresAt = now() + ttlMs;
      const tickets: string[] = [];
      const set = new Set<string>();
      for (const kind of kinds) {
        // The random half reuses the host's opaque-id minter so the
        // random-secret recipe lives in one place.
        const ticket = `${DIRECT_TICKET_PREFIX}${mintHexId()}`;
        pending.set(ticket, { peerDeviceId, expiresAt, kind });
        set.add(ticket);
        tickets.push(ticket);
      }
      if (set.size > 0) byPeer.set(peerDeviceId, set);
      return tickets;
    },

    async consumeProven(peerDeviceId, arrivedAs, matches) {
      // Snapshot before awaiting: the predicate yields, and a
      // concurrent mint or sweep must not be walked mid-mutation.
      const candidates = [...(byPeer.get(peerDeviceId) ?? [])];
      const cutoff = now();
      for (const ticket of candidates) {
        const entry = pending.get(ticket);
        if (entry === undefined) continue;
        if (entry.expiresAt <= cutoff) continue;
        if (entry.kind !== arrivedAs) continue;
        // oxlint-disable-next-line no-await-in-loop -- stop at the ticket that matches, rather than computing every candidate's proof
        if (!(await matches(ticket))) continue;
        // Single use. The delete's own answer is the claim: two dials
        // racing one ticket across the await above would otherwise
        // both see it pending and both be admitted.
        if (!pending.delete(ticket)) continue;
        forget(ticket, entry.peerDeviceId);
        return ticket;
      }
      return null;
    },
  };
}
