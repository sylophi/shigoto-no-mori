// PKCE (RFC 7636) and the authorize-URL builder for the RFC 8252
// native-app authorization code flow. Pure and portable: the crypto
// primitives are WebCrypto globals present in both node 22 and browsers
// (crypto.getRandomValues, crypto.subtle.digest) with a manual base64url
// encoder, so this one implementation drives the desktop login and the
// web client alike, and the account check script asserts the challenge
// math without a browser.
import type { AccountServiceConfig } from "./serviceConfig";

// base64url with no padding, the encoding RFC 7636 mandates for both the
// verifier and the challenge. btoa is a global in both node 22 and
// browsers, so no Buffer is needed and the encoder stays portable.
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Cryptographically strong random bytes from the WebCrypto global, the
// portable replacement for node:crypto randomBytes.
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export type PkcePair = {
  // The high-entropy secret kept in memory and sent to the token
  // endpoint. 43 characters (32 bytes base64url), inside the 43-128 range
  // RFC 7636 allows.
  verifier: string;
  // base64url(sha256(verifier)), the value that rides in the authorize
  // URL so the redirect cannot be replayed without the verifier.
  challenge: string;
};

// 32 random bytes give a 43-char base64url verifier, the RFC minimum
// length and plenty of entropy. The challenge is the S256 transform,
// computed through crypto.subtle.digest, which is async, so the pair is
// resolved through a promise the callers await.
export async function generatePkcePair(): Promise<PkcePair> {
  const verifier = base64Url(randomBytes(32));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64Url(new Uint8Array(digest));
  return { verifier, challenge };
}

// A random state value for CSRF protection on the redirect. Separate from
// the verifier so a leaked state reveals nothing about the code exchange.
// Synchronous because it needs no digest, only random bytes.
export function generateState(): string {
  return base64Url(randomBytes(16));
}

// Builds the authorization request URL. code_challenge_method is always
// S256 (this app never uses plain), and every parameter RFC 6749 and RFC
// 7636 require is present so a spec-compliant provider accepts it.
export function buildAuthorizeUrl(
  config: AccountServiceConfig,
  params: { redirectUri: string; challenge: string; state: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// The parsed redirect: either an authorization code with its state, or a
// provider-reported error. The loopback server hands its request URL
// here. A relative URL is resolved against a throwaway base since only
// the query matters.
export type RedirectResult =
  | { code: string; state: string }
  | { error: string };

export function parseRedirectQuery(rawUrl: string): RedirectResult {
  const url = new URL(rawUrl, "http://127.0.0.1");
  const error = url.searchParams.get("error");
  if (error) return { error };
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return { error: "missing code or state in redirect" };
  return { code, state };
}
