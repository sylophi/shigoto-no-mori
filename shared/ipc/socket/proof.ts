// Mutual proof of ticket possession for the direct data plane's hello.
//
// The dialer races candidate addresses it learned from the peer, and a
// plain ws:// LAN address is answered by whoever holds it on the
// network the dialer is sitting on. A ticket sent in the hello would go
// to that machine, which could then spend it against the real listener.
//
// So the ticket never travels. The host opens with a nonce, the client
// answers with its own nonce and an HMAC of both under the ticket, and
// the welcome carries the host's HMAC of the same pair under the other
// role. Neither side trusts a far end that cannot produce its half.
//
// This is not confidentiality: a LAN candidate is still plaintext, and
// closing that needs TLS pinned through the hub. There is deliberately
// no fallback to a ticket-in-hello handshake, since an attacker who
// could ask for one would downgrade every dial.
//
// Web Crypto only, no node builtins: the same helper serves the host,
// the desktop dialer and the web client.

// Domain separation, versioned so a changed construction cannot be
// confused with this one.
const PROOF_DOMAIN = "sm-direct-v1";

// 128 bits. A nonce is public and only has to never repeat per ticket.
const NONCE_BYTES = 16;

// Enforced at the frame schema, so a malformed nonce is a malformed
// frame and never reaches the proof construction.
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

// Both proofs cover the same nonce pair, so the role is what keeps the
// client's proof from being replayed back at it as the host's.
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

// Runs to the end regardless, so a shared prefix is not measurable.
export function proofsMatch(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
