import * as Schema from "effect/Schema";
import { HexId32Schema } from "../schemas/hexId.ts";

// Each candidate carries its own single-use ticket, so the dialer can
// race them all: a loser burns only its own. Knowing how to dial grants
// nothing: the link still gates every command.

// Long enough for a dial over any candidate, short enough that a stale
// answer can't be replayed much later. Matches the hub's ticket TTL.
export const DIRECT_TICKET_TTL_MS = 60_000;

// Caps a machine with many virtual interfaces.
export const MAX_DIRECT_CANDIDATES = 6;

const DirectCandidateKindSchema = Schema.Literals(["lan", "tunnel"]);
export type DirectCandidateKind = typeof DirectCandidateKindSchema.Type;

// The host builds the full URL, so the two sides can't disagree: "lan"
// is ws:// at an IP literal with a port (the listener binds an
// ephemeral one), "tunnel" wss:// at a hostname (the edge serves 443).
const DirectCandidateSchema = Schema.Struct({
  kind: DirectCandidateKindSchema,
  url: Schema.String,
  ticket: Schema.String,
});
export type DirectCandidate = typeof DirectCandidateSchema.Type;

export const ALL_DIRECT_CANDIDATE_KINDS: readonly DirectCandidateKind[] =
  DirectCandidateKindSchema.literals;

// The caller's dial kinds, so the host mints only tickets it can spend,
// and its connection, so a web device's tabs asking at once don't void
// each other's tickets.
export const DirectConnectInfoInputSchema = Schema.Struct({
  dialableKinds: Schema.Array(DirectCandidateKindSchema),
  connectionId: HexId32Schema,
});
export type DirectConnectInfoInput = typeof DirectConnectInfoInputSchema.Type;

// Never an empty list: nothing dialable answers available:false.
// acceptsCommands and sharesData inform the asker's UI only; the
// listener's gate still decides every call.
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
