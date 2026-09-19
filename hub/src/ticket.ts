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
// base64url(16 random bytes) + "." + base64url(HMAC-SHA256 of the two
// halves before it, keyed by the TICKET_SIGNING_KEY secret). The
// account part exists purely so GET /connect can route to the right
// Durable Object without a database hit. The DO stores and consumes
// only the random part. The signature is not what makes a ticket
// valid, the DO's stored random is. It exists because GET /connect is
// unauthenticated: without it anyone could name a Durable Object of
// their choosing per request, each one a billed DO request. A forged
// ticket now dies in the Worker.
export const TICKET_PREFIX = "smrt_";

// How long a minted ticket stays valid. Long enough to open one TLS
// websocket, short enough that a leaked URL goes stale before it is
// useful. The Worker honors a TICKET_TTL_MS env override so tests can
// exercise expiry with real (tiny) waits instead of fake timers.
export const TICKET_TTL_MS = 60_000;

function base64urlEncode(text: string): string {
  return base64urlOfBytes(new TextEncoder().encode(text));
}

function base64urlToBytes(encoded: string): Uint8Array<ArrayBuffer> | null {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

// Imported per call: an HMAC key import is far cheaper than the DO
// round trip every caller makes next, and no isolate-level cache has
// to be kept in step with a rotated secret.
async function hmacKey(signingKey: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function buildTicket(
  signingKey: string,
  accountId: string,
  random: string,
): Promise<string> {
  const body = `${base64urlEncode(accountId)}.${random}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(signingKey),
    new TextEncoder().encode(body),
  );
  return `${TICKET_PREFIX}${body}.${base64urlOfBytes(new Uint8Array(signature))}`;
}

// The random half is base64url of 16 bytes, which is always exactly 22
// base64url characters. Matching the exact shape here means a garbage
// or oversized random never becomes a storage key inside the DO.
const TICKET_RANDOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// The signature is base64url of the 32-byte HMAC-SHA256 output, always
// exactly 43 characters.
const TICKET_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// The encoded account half is bounded before decoding so a giant
// ticket cannot force a large decode or a large idFromName argument. A
// Clerk `sub` is short, so 128 encoded characters is generous.
const MAX_ENCODED_ACCOUNT_LENGTH = 128;

// Splits a ticket into its routing half (accountId) and its secret
// half (random). Returns null for anything structurally off or not
// signed by this Worker, so the Worker can reject before ever naming a
// Durable Object. The shape checks are strict on purpose and run
// before the signature check. A malformed ticket must fail here as
// plain HTTP, never as a crash or an oversized storage key deeper in.
export async function parseTicket(
  signingKey: string,
  ticket: string,
): Promise<{ accountId: string; random: string } | null> {
  if (!ticket.startsWith(TICKET_PREFIX)) return null;
  const parts = ticket.slice(TICKET_PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  const [encodedAccount, random, encodedSignature] = parts;
  if (!TICKET_RANDOM_PATTERN.test(random)) return null;
  if (!TICKET_SIGNATURE_PATTERN.test(encodedSignature)) return null;
  if (
    encodedAccount.length === 0 ||
    encodedAccount.length > MAX_ENCODED_ACCOUNT_LENGTH
  )
    return null;
  const accountBytes = base64urlToBytes(encodedAccount);
  const signature = base64urlToBytes(encodedSignature);
  if (accountBytes === null || signature === null) return null;
  // subtle.verify compares in constant time.
  const signed = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(signingKey),
    signature,
    new TextEncoder().encode(`${encodedAccount}.${random}`),
  );
  if (!signed) return null;
  const accountId = new TextDecoder().decode(accountBytes);
  return accountId.length === 0 ? null : { accountId, random };
}
