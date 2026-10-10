import * as Schema from "effect/Schema";
import { HexId32Schema } from "../schemas/hexId.ts";

// Brokering vocabulary for the direct data plane: a peer asks this
// host, with the device hub's one ask (connectInfo, shared/hub/link.ts),
// how to dial it directly. The answer is a list of fully dialable
// CANDIDATES, each carrying its kind (a LAN interface address or the
// wss tunnel endpoint), the complete dial URL, and ONE short-lived
// single-use connect ticket of its own, each bound to the asking
// peer's deviceId (the hub stamps it, see host/direct/connectInfo.ts).
// Per-candidate tickets are what let the dialer race every candidate at
// once: a candidate that reaches the host but loses the race burns only
// its own ticket, never another candidate's. Knowing how to dial grants
// nothing by itself: the device link gates every command on the host's
// command-access switch. The answer also reports that switch
// (acceptsCommands), so the dialer knows up front whether this host
// will run its commands, and the host's account:commandAccessChanged
// push keeps that reading live afterwards.

// How long a minted connect ticket stays valid. Long enough for the
// peer's dial to reach us over any candidate address, short enough
// that a stale connectInfo answer cannot be replayed much later.
// Matches the hub worker's connect-ticket TTL. Lives here, beside
// the connectInfo contract whose answers the ticket rides, rather than
// in its one consumer (host/direct/tickets.ts): the TTL is a fact of
// the brokered exchange both ends read, and shared/ cannot import
// host/ to reach it.
export const DIRECT_TICKET_TTL_MS = 60_000;

// The LAN interface addresses a host advertises, capped so a machine
// with many virtual interfaces (Docker bridges, VPNs, VMs) cannot fan
// an unbounded candidate list at a dialer. The single source both
// sides share: host/direct/addresses.ts caps its enumeration here, and
// the dialer bounds its race at this plus the one tunnel candidate, so
// a hostile or buggy connectInfo answer cannot fan out an unbounded
// dial burst either.
export const MAX_DIRECT_CANDIDATES = 6;

// One dialable candidate. The host builds the full URL (ws:// from an
// interface address and the listener port, wss:// for the tunnel
// endpoint), so the dialer consumes it as-is and the two sides cannot
// disagree on how URL and ticket line up. The kind is the platform
// capability key: a browser page can only dial wss tunnel candidates
// (mixed content forbids ws:// under https), the app dials both.
//
// Candidates are PEER-SUPPLIED, so the kind-to-scheme invariant is
// enforced right here at the boundary: a buggy or compromised host
// must not be able to point a dialer, ticket and hello in hand, at an
// arbitrary URL. "lan" means ws:// at an IP literal with an explicit
// port (the listener always binds an ephemeral port, so a portless
// URL is never legitimate); "tunnel" means wss:// at a DNS hostname
// with no explicit port (the tunnel edge serves 443 only).
function candidateUrlMatchesKind(
  kind: "lan" | "tunnel",
  rawUrl: string,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  // WHATWG keeps IPv6 literals bracketed in `hostname`.
  const isIpLiteral =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ||
    (url.hostname.startsWith("[") && url.hostname.endsWith("]"));
  if (kind === "lan") {
    return url.protocol === "ws:" && url.port !== "" && isIpLiteral;
  }
  return (
    url.protocol === "wss:" &&
    url.hostname !== "" &&
    url.port === "" &&
    !isIpLiteral
  );
}

const DirectCandidateKindSchema = Schema.Literals(["lan", "tunnel"]);
export type DirectCandidateKind = typeof DirectCandidateKindSchema.Type;

export const DirectCandidateSchema = Schema.Struct({
  kind: DirectCandidateKindSchema,
  url: Schema.String,
  ticket: Schema.String,
}).check(
  Schema.makeFilter(
    (candidate: { readonly kind: DirectCandidateKind; readonly url: string }) =>
      candidateUrlMatchesKind(candidate.kind, candidate.url) ||
      "candidate url does not match its kind",
  ),
);
export type DirectCandidate = typeof DirectCandidateSchema.Type;

// Every candidate kind, derived from the schema so the vocabulary has
// one owner: the dialer's race-everything default reads this.
export const ALL_DIRECT_CANDIDATE_KINDS: readonly DirectCandidateKind[] =
  DirectCandidateKindSchema.literals;

// The caller's dial capability, carried in the connectInfo INPUT so
// the host mints only tickets the caller can actually spend: a web
// caller declaring ["tunnel"] does not burn and abandon one lan ticket
// per interface address on every ask. And the connection the caller is
// dialing for, which its hello names too: the host keeps a set of
// tickets per connection, so a web device's tabs asking at once do not
// void each other's.
export const DirectConnectInfoInputSchema = Schema.Struct({
  dialableKinds: Schema.Array(DirectCandidateKindSchema),
  connectionId: HexId32Schema,
});
export type DirectConnectInfoInput = typeof DirectConnectInfoInputSchema.Type;

// Candidates exactly when available, and never an empty list: a host
// with nothing dialable (for this caller's declared kinds) answers
// available:false instead. acceptsCommands is the host's
// command-access switch: whether its direct listener runs the asker's
// gated calls. Every asker is a device of the same account, so it is
// the same bit for all of them. It informs the asker's UI and CLI
// only; the listener's dispatch gate still decides every call.
// sharesData is the host's sharing switch, read the same way: off, its
// link serves the asker nothing.
export const DirectConnectInfoSchema = Schema.Union([
  Schema.Struct({ available: Schema.Literal(false) }),
  Schema.Struct({
    available: Schema.Literal(true),
    candidates: Schema.Array(DirectCandidateSchema).check(
      Schema.isMinLength(1),
    ),
    acceptsCommands: Schema.Boolean,
    sharesData: Schema.Boolean,
  }),
]);
export type DirectConnectInfo = typeof DirectConnectInfoSchema.Type;
