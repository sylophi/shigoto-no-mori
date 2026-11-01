// Small crypto helpers on the Web Crypto API (no node builtins, this
// runs in workerd).
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";

export function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Base64Url.encode(bytes);
}

// Hex SHA-256 of a string, the shape stored in devices.credential_hash.
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Hex.encode(new Uint8Array(digest));
}
