// This device's static key pair as the account layer keeps it: the
// private key beside the hub credential in the same store, the public
// key on the hub's row for the device, both as unpadded base64url. A
// fresh pair is made at every enrollment.
//
// Pure: btoa and atob are in Node and every browser.
import { generateKeyPair, type KeyPair, keyPairFromPrivateKey } from "./noise";

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Throws on text that is not base64url.
export function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function newDeviceKey(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPair();
  return {
    privateKey: toBase64Url(pair.privateKey),
    publicKey: toBase64Url(pair.publicKey),
  };
}

export function deviceKeyPair(privateKey: string): KeyPair {
  return keyPairFromPrivateKey(fromBase64Url(privateKey));
}
