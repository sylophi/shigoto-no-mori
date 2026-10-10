// The Noise Protocol Framework (revision 34, noiseprotocol.org/noise.html)
// as one protocol: Noise_IK_25519_ChaChaPoly_SHA256. Written to be read
// beside the specification: the objects are its CipherState,
// SymmetricState and HandshakeState (section 5), the methods carry its
// names, and the comments cite its sections. The primitives come from
// the noble libraries; nothing below the handshake pattern is written
// here. Checked against the cacophony test vectors (pnpm test noise).
//
// IK (section 7.5): the initiator knows the responder's static key
// before it starts, from the hub's roster, and sends its own, encrypted,
// in the first message. Two messages, after which each side holds a
// CipherState per direction. Who the far end is, is the caller's check:
// the responder reads the initiator's static key off the handshake
// (remoteStaticKey) and compares it with the roster's key for the device
// it claims to be.
//
// Pure: no node builtins, no electron, so the host, the desktop dialer
// and the web client run the same code.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";

// Section 4: DHLEN for 25519, HASHLEN for SHA256, and the AEAD tag.
const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;

// Section 3: every handshake message fits in 65535 bytes. Transport
// messages are not held to it here: each rides one websocket frame,
// which carries its own length, up to the link's frame cap.
const MAX_HANDSHAKE_MESSAGE = 65535;

// Section 5.1: 2^64-1 is reserved. A counter never gets near the
// largest integer a double holds exactly, which is the bound kept.
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

const EMPTY = new Uint8Array(0);

// A handshake that cannot go on: a message that does not decrypt, has
// the wrong length or comes out of turn. The caller drops the
// connection; nothing about the failure is told to the far end.
export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

export type KeyPair = {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
};

// ---- Section 4.1: DH functions ----

// GENERATE_KEYPAIR().
export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { publicKey, privateKey: secretKey };
}

// The key pair a stored private key belongs to.
export function keyPairFromPrivateKey(privateKey: Uint8Array): KeyPair {
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

// DH(key_pair, public_key). noble refuses a public key whose result is
// all zeros (a low-order point), which section 12.1 allows.
function dh(keyPair: KeyPair, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(keyPair.privateKey, publicKey);
}

// ---- Section 4.2: cipher functions ----

// ChaChaPoly's 96-bit nonce: 32 bits of zeros, then n as a 64-bit
// little-endian integer.
function nonceBytes(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, n % 2 ** 32, true);
  view.setUint32(8, Math.floor(n / 2 ** 32), true);
  return nonce;
}

function encrypt(
  k: Uint8Array,
  n: number,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return chacha20poly1305(k, nonceBytes(n), ad).encrypt(plaintext);
}

function decrypt(
  k: Uint8Array,
  n: number,
  ad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  try {
    return chacha20poly1305(k, nonceBytes(n), ad).decrypt(ciphertext);
  } catch {
    throw new NoiseError("a message failed authentication");
  }
}

// ---- Section 4.3: hash functions ----

function hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

// HKDF(chaining_key, input_key_material, 2): RFC 5869's HKDF with the
// chaining key as the salt and no info gives section 4.3's output1 and
// output2 as its first 64 bytes.
function hkdf2(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
): [Uint8Array, Uint8Array] {
  const output = hkdf(
    sha256,
    inputKeyMaterial,
    chainingKey,
    EMPTY,
    2 * HASHLEN,
  );
  return [output.slice(0, HASHLEN), output.slice(HASHLEN)];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---- Section 5.1: CipherState ----

class CipherState {
  private k: Uint8Array | null = null;
  private n = 0;

  initializeKey(key: Uint8Array): void {
    this.k = key;
    this.n = 0;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext;
    if (this.n >= MAX_NONCE) throw new NoiseError("the nonce ran out");
    const ciphertext = encrypt(this.k, this.n, ad, plaintext);
    this.n += 1;
    return ciphertext;
  }

  // A failed decryption leaves n where it was (section 5.1), so the
  // sender's next message, which carries the same n, is still read.
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext;
    if (this.n >= MAX_NONCE) throw new NoiseError("the nonce ran out");
    const plaintext = decrypt(this.k, this.n, ad, ciphertext);
    this.n += 1;
    return plaintext;
  }
}

// ---- Section 5.2: SymmetricState ----

class SymmetricState {
  private readonly cipherState = new CipherState();
  private ck: Uint8Array;
  private h: Uint8Array;

  // InitializeSymmetric(protocol_name).
  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = hash(name);
    }
    this.ck = this.h;
  }

  // HASHLEN is 32, so temp_k needs no truncation.
  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, inputKeyMaterial);
    this.ck = ck;
    this.cipherState.initializeKey(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concat(this.h, data));
  }

  hasKey(): boolean {
    return this.cipherState.hasKey();
  }

  handshakeHash(): Uint8Array {
    return this.h;
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipherState.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipherState.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [tempK1, tempK2] = hkdf2(this.ck, EMPTY);
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(tempK1);
    c2.initializeKey(tempK2);
    return [c1, c2];
  }
}

// ---- Section 7.5: the IK pattern ----
//
//   IK:
//     <- s
//     ...
//     -> e, es, s, ss
//     <- e, ee, se

type Token = "e" | "s" | "ee" | "es" | "se" | "ss";

const IK_MESSAGE_PATTERNS: readonly (readonly Token[])[] = [
  ["e", "es", "s", "ss"],
  ["e", "ee", "se"],
];

// What a finished handshake hands its side: c1 is the initiator's
// sending cipher and c2 the responder's (section 5.3, Split).
export type TransportCiphers = {
  readonly send: CipherState;
  readonly receive: CipherState;
};

// ---- Section 5.3: HandshakeState ----

export class HandshakeState {
  private readonly symmetricState: SymmetricState;
  private readonly initiator: boolean;
  private readonly s: KeyPair;
  private e: KeyPair | null;
  private rs: Uint8Array | null;
  private re: Uint8Array | null = null;
  // The index of the next message pattern; message i is written by the
  // initiator when i is even.
  private next = 0;

  // Initialize(handshake_pattern, initiator, prologue, s, e, rs, re).
  // The initiator passes rs, the responder's static public key; `e` is
  // given only by the test vectors, which fix the ephemeral keys.
  constructor(opts: {
    readonly initiator: boolean;
    readonly prologue: Uint8Array;
    readonly s: KeyPair;
    readonly rs?: Uint8Array;
    readonly e?: KeyPair;
  }) {
    this.symmetricState = new SymmetricState(PROTOCOL_NAME);
    this.initiator = opts.initiator;
    this.s = opts.s;
    this.e = opts.e ?? null;
    this.rs = opts.rs ?? null;
    this.symmetricState.mixHash(opts.prologue);
    // The pre-message "<- s": the responder's static key, which the
    // initiator holds as rs and the responder as its own s.
    if (this.initiator) {
      if (this.rs === null) {
        throw new NoiseError("the initiator needs the responder's key");
      }
      this.symmetricState.mixHash(this.rs);
    } else {
      this.symmetricState.mixHash(this.s.publicKey);
    }
  }

  // The far end's static public key, once the handshake has carried it
  // (the responder learns it from the first message).
  remoteStaticKey(): Uint8Array | null {
    return this.rs;
  }

  handshakeHash(): Uint8Array {
    return this.symmetricState.handshakeHash();
  }

  // WriteMessage(payload, message_buffer). Answers the message and,
  // after the last one, this side's transport ciphers.
  writeMessage(payload: Uint8Array): {
    readonly message: Uint8Array;
    readonly transport: TransportCiphers | null;
  } {
    const pattern = this.takePattern(true);
    const parts: Uint8Array[] = [];
    for (const token of pattern) {
      if (token === "e") {
        this.e ??= generateKeyPair();
        parts.push(this.e.publicKey);
        this.symmetricState.mixHash(this.e.publicKey);
      } else if (token === "s") {
        parts.push(this.symmetricState.encryptAndHash(this.s.publicKey));
      } else {
        this.symmetricState.mixKey(this.dhFor(token));
      }
    }
    parts.push(this.symmetricState.encryptAndHash(payload));
    const message = concat(...parts);
    if (message.length > MAX_HANDSHAKE_MESSAGE) {
      throw new NoiseError("a handshake message is over 65535 bytes");
    }
    return { message, transport: this.transportIfDone() };
  }

  // ReadMessage(message, payload_buffer). Answers the payload and,
  // after the last message, this side's transport ciphers.
  readMessage(message: Uint8Array): {
    readonly payload: Uint8Array;
    readonly transport: TransportCiphers | null;
  } {
    if (message.length > MAX_HANDSHAKE_MESSAGE) {
      throw new NoiseError("a handshake message is over 65535 bytes");
    }
    const pattern = this.takePattern(false);
    let offset = 0;
    const take = (length: number): Uint8Array => {
      if (offset + length > message.length) {
        throw new NoiseError("a handshake message is too short");
      }
      const bytes = message.subarray(offset, offset + length);
      offset += length;
      return bytes;
    };
    for (const token of pattern) {
      if (token === "e") {
        this.re = take(DHLEN).slice();
        this.symmetricState.mixHash(this.re);
      } else if (token === "s") {
        const length = this.symmetricState.hasKey() ? DHLEN + TAGLEN : DHLEN;
        this.rs = this.symmetricState.decryptAndHash(take(length));
      } else {
        this.symmetricState.mixKey(this.dhFor(token));
      }
    }
    const payload = this.symmetricState.decryptAndHash(
      message.subarray(offset),
    );
    return { payload, transport: this.transportIfDone() };
  }

  // The next message pattern, if it is this side's turn to write
  // (writing) or to read (reading).
  private takePattern(writing: boolean): readonly Token[] {
    const pattern = IK_MESSAGE_PATTERNS[this.next];
    const initiatorWrites = this.next % 2 === 0;
    if (
      pattern === undefined ||
      writing !== (initiatorWrites === this.initiator)
    ) {
      throw new NoiseError("a handshake message out of turn");
    }
    this.next += 1;
    return pattern;
  }

  // The DH a token names, from this side's point of view: "es" is the
  // initiator's e with the responder's s, so the initiator computes
  // DH(e, rs) and the responder DH(s, re).
  private dhFor(token: "ee" | "es" | "se" | "ss"): Uint8Array {
    const e = this.e;
    const re = this.re;
    const rs = this.rs;
    const need = <T>(value: T | null): T => {
      if (value === null) throw new NoiseError(`no key for ${token}`);
      return value;
    };
    switch (token) {
      case "ee":
        return dh(need(e), need(re));
      case "es":
        return this.initiator ? dh(need(e), need(rs)) : dh(this.s, need(re));
      case "se":
        return this.initiator ? dh(this.s, need(re)) : dh(need(e), need(rs));
      case "ss":
        return dh(this.s, need(rs));
    }
  }

  private transportIfDone(): TransportCiphers | null {
    if (this.next < IK_MESSAGE_PATTERNS.length) return null;
    const [c1, c2] = this.symmetricState.split();
    return this.initiator
      ? { send: c1, receive: c2 }
      : { send: c2, receive: c1 };
  }
}
