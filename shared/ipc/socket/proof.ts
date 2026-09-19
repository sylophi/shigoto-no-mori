// Mutual proof of ticket possession for the direct data plane's hello.
//
// The connect ticket is a bearer secret, and the dialer races candidate
// addresses it learned from the peer: LAN interface addresses that are
// plain ws:// and answered by whoever holds that address on whatever
// network the dialer is currently sitting on. Handing the ticket over
// as the first frame therefore handed it to the first machine that
// accepted a socket, which on a hostile network is not the peer. That
// machine could then spend the still-live ticket against the real
// listener over a different candidate.
//
// So the ticket never travels. The host opens with a random nonce, the
// client answers with its own nonce and an HMAC of both under the
// ticket, and the welcome carries the host's HMAC of the same pair
// under the other role. Each side proves it already holds the ticket
// without revealing it, and a recorded exchange is worthless against
// the next one because both nonces are fresh. A machine that does not
// hold the ticket cannot produce either half, so an impostor on a LAN
// address is caught at the welcome instead of being trusted.
//
// This is not confidentiality: a LAN candidate is still plaintext, so
// anyone already positioned on that network reads and can rewrite the
// traffic that follows. Closing that needs TLS on the LAN candidate
// with the certificate pinned through the hub. What this does close is
// the theft of a reusable credential by a machine that merely answered
// first.
//
// Pure browser-global code (Web Crypto, no node builtins): the same
// helper serves the host, the desktop dialer and the web client.

// Domain separation, so a proof can only ever be read as what it is.
// The version rides along because both ends are app builds that the
// owner rolls out together: there is deliberately NO fallback to the
// old ticket-in-hello handshake, since an attacker who could ask for
// one would simply downgrade every dial back into the hole above.
const PROOF_DOMAIN = "sm-direct-v1";

// 128 bits, the same width as the ticket's own random half. The nonce
// is public; it only has to never repeat for a given ticket.
const NONCE_BYTES = 16;

// The wire shape of both nonces, enforced at the frame schema so a
// malformed one is a malformed hello rather than something the proof
// construction has to defend against.
export const HANDSHAKE_NONCE_PATTERN = /^[0-9a-f]{32}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function newHandshakeNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// Which end of the exchange a proof speaks for. Both halves cover the
// same two nonces, so the role is what keeps the client's proof from
// being replayed straight back at it as the host's.
export type HandshakeRole = "client" | "host";

export async function handshakeProof(
  ticket: string,
  role: HandshakeRole,
  hostNonce: string,
  clientNonce: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ticket),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${PROOF_DOMAIN}:${role}:${hostNonce}:${clientNonce}`),
  );
  return toHex(new Uint8Array(mac));
}

// Constant-time-ish compare over the hex text. Both sides are fixed
// width, so the length check leaks nothing, and the loop runs to the
// end regardless so a shared prefix is not measurable.
export function proofsMatch(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
