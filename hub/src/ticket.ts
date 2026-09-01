// The worker-internal string mechanics behind the two bearer secrets.
// The app never builds or parses either: the credential rides in the
// Authorization header and the ticket in the connect URL as opaque
// strings, so this lives in hub/src and not in the shared contract
// (shared/hub/protocol.ts).
import { base64urlOfBytes } from "./crypto.ts";

// A device credential is `smdc_` + base64url(32 random bytes). The raw
// string is returned exactly once by POST /devices/enroll and rides
// only in Authorization headers, never in URLs. The Worker stores its
// SHA-256 hash only. The prefix exists so the worker's auth-tier check
// can keep Clerk tokens and credentials from hitting the wrong tier.
export const DEVICE_CREDENTIAL_PREFIX = "smdc_";

// A connection ticket is `smrt_` + base64url(accountId) + "." +
// base64url(16 random bytes). The account part exists purely so
// GET /connect can route to the right Durable Object without a
// database hit. The DO stores and consumes only the random part, so a
// forged account part names a DO that has never seen the random and
// the ticket fails closed.
export const TICKET_PREFIX = "smrt_";

// How long a minted ticket stays valid. Long enough to open one TLS
// websocket, short enough that a leaked URL goes stale before it is
// useful. The Worker honors a TICKET_TTL_MS env override so tests can
// exercise expiry with real (tiny) waits instead of fake timers.
export const TICKET_TTL_MS = 60_000;

function base64urlEncode(text: string): string {
  return base64urlOfBytes(new TextEncoder().encode(text));
}

function base64urlDecode(encoded: string): string | null {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function buildTicket(accountId: string, random: string): string {
  return `${TICKET_PREFIX}${base64urlEncode(accountId)}.${random}`;
}

// The random half is base64url of 16 bytes, which is always exactly 22
// base64url characters. Matching the exact shape here means a garbage
// or oversized random never becomes a storage key inside the DO.
const TICKET_RANDOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// The encoded account half is bounded before decoding so a giant
// ticket cannot force a large decode or a large idFromName argument. A
// Clerk `sub` is short, so 128 encoded characters is generous.
const MAX_ENCODED_ACCOUNT_LENGTH = 128;

// Splits a ticket into its routing half (accountId) and its secret
// half (random). Returns null for anything structurally off, so the
// Worker can reject before ever naming a Durable Object. The shape
// checks are strict on purpose. A malformed ticket must fail here as
// plain HTTP, never as a crash or an oversized storage key deeper in.
export function parseTicket(
  ticket: string,
): { accountId: string; random: string } | null {
  if (!ticket.startsWith(TICKET_PREFIX)) return null;
  const body = ticket.slice(TICKET_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  const encodedAccount = body.slice(0, dot);
  const random = body.slice(dot + 1);
  if (!TICKET_RANDOM_PATTERN.test(random)) return null;
  if (encodedAccount.length > MAX_ENCODED_ACCOUNT_LENGTH) return null;
  const accountId = base64urlDecode(encodedAccount);
  if (accountId === null || accountId.length === 0) return null;
  return { accountId, random };
}
