// Proof for the Noise handshake and transport ciphers
// (shared/crypto/noise.ts): the cacophony test vector for
// Noise_IK_25519_ChaChaPoly_SHA256 byte for byte, both sides
// authenticated, a wrong static key or prologue refused, messages out
// of turn and replayed refused, a tampered or reordered transport
// message refused without spending the nonce, and a frame at the device
// link's cap.
//
// Run: pnpm test noise.
import assert from "node:assert/strict";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { it } from "vitest";
import {
  generateKeyPair,
  HandshakeState,
  type KeyPair,
  keyPairFromPrivateKey,
  NoiseError,
  type TransportCiphers,
} from "../shared/crypto/noise.ts";
import {
  fromBase64Url,
  deviceKeyPair,
  toBase64Url,
  newDeviceKey,
} from "../shared/crypto/deviceKey.ts";
import vectors from "./noise-vectors.json" with { type: "json" };

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const text = (value: string) => new TextEncoder().encode(value);

const PROLOGUE = text("sm-test");

// One finished handshake between two fresh devices.
function handshake(): {
  initiator: KeyPair;
  responder: KeyPair;
  initiatorSide: TransportCiphers;
  responderSide: TransportCiphers;
  learned: Uint8Array | null;
} {
  const initiator = generateKeyPair();
  const responder = generateKeyPair();
  const i = new HandshakeState({
    initiator: true,
    prologue: PROLOGUE,
    s: initiator,
    rs: responder.publicKey,
  });
  const r = new HandshakeState({
    initiator: false,
    prologue: PROLOGUE,
    s: responder,
  });
  r.readMessage(i.writeMessage(text("hello")).message);
  const answer = r.writeMessage(text("welcome"));
  const finished = i.readMessage(answer.message);
  assert.ok(answer.transport !== null && finished.transport !== null);
  return {
    initiator,
    responder,
    initiatorSide: finished.transport,
    responderSide: answer.transport,
    learned: r.remoteStaticKey(),
  };
}

it("matches the cacophony vector for Noise_IK_25519_ChaChaPoly_SHA256", () => {
  const v = vectors.vector;
  const initiatorStatic = keyPairFromPrivateKey(hex(v.init_static));
  const responderStatic = keyPairFromPrivateKey(hex(v.resp_static));
  const i = new HandshakeState({
    initiator: true,
    prologue: hex(v.init_prologue),
    s: initiatorStatic,
    e: keyPairFromPrivateKey(hex(v.init_ephemeral)),
    rs: hex(v.init_remote_static),
  });
  const r = new HandshakeState({
    initiator: false,
    prologue: hex(v.resp_prologue),
    s: responderStatic,
    e: keyPairFromPrivateKey(hex(v.resp_ephemeral)),
  });
  const [m0, m1, ...transportMessages] = v.messages;
  assert.ok(m0 !== undefined && m1 !== undefined);

  const first = i.writeMessage(hex(m0.payload));
  assert.equal(toHex(first.message), m0.ciphertext);
  assert.equal(toHex(r.readMessage(first.message).payload), m0.payload);
  assert.deepEqual(r.remoteStaticKey(), initiatorStatic.publicKey);

  const second = r.writeMessage(hex(m1.payload));
  assert.equal(toHex(second.message), m1.ciphertext);
  const read = i.readMessage(second.message);
  assert.equal(toHex(read.payload), m1.payload);
  assert.equal(toHex(i.handshakeHash()), v.handshake_hash);
  assert.equal(toHex(r.handshakeHash()), v.handshake_hash);

  // After the handshake the vector's messages alternate, the initiator
  // first.
  const initiatorSide = read.transport;
  const responderSide = second.transport;
  assert.ok(initiatorSide !== null && responderSide !== null);
  transportMessages.forEach((message, index) => {
    const [sender, receiver] =
      index % 2 === 0
        ? [initiatorSide, responderSide]
        : [responderSide, initiatorSide];
    const sealed = sender.send.encryptWithAd(
      new Uint8Array(0),
      hex(message.payload),
    );
    assert.equal(toHex(sealed), message.ciphertext);
    assert.equal(
      toHex(receiver.receive.decryptWithAd(new Uint8Array(0), sealed)),
      message.payload,
    );
  });
});

it("authenticates both sides and carries frames each way", () => {
  const { initiator, initiatorSide, responderSide, learned } = handshake();
  // The responder learns who dialed from the handshake itself.
  assert.deepEqual(learned, initiator.publicKey);
  const ad = new Uint8Array(0);
  const up = initiatorSide.send.encryptWithAd(ad, text("up"));
  assert.equal(
    new TextDecoder().decode(responderSide.receive.decryptWithAd(ad, up)),
    "up",
  );
  const down = responderSide.send.encryptWithAd(ad, text("down"));
  assert.equal(
    new TextDecoder().decode(initiatorSide.receive.decryptWithAd(ad, down)),
    "down",
  );
  // Each frame grows by the tag alone.
  assert.equal(up.length, 2 + 16);
});

it("refuses a first message sealed to another device's key", () => {
  const initiator = generateKeyPair();
  const meant = generateKeyPair();
  const actual = generateKeyPair();
  const i = new HandshakeState({
    initiator: true,
    prologue: PROLOGUE,
    s: initiator,
    rs: meant.publicKey,
  });
  const r = new HandshakeState({
    initiator: false,
    prologue: PROLOGUE,
    s: actual,
  });
  assert.throws(
    () => r.readMessage(i.writeMessage(text("hi")).message),
    NoiseError,
  );
});

it("leaves the initiator unable to read an answer from the wrong responder", () => {
  // A responder that holds the key the initiator dialed but answers
  // from a session it did not share (an impostor replaying its own
  // second message) is refused.
  const initiator = generateKeyPair();
  const responder = generateKeyPair();
  const start = () =>
    new HandshakeState({
      initiator: true,
      prologue: PROLOGUE,
      s: initiator,
      rs: responder.publicKey,
    });
  const first = start();
  const r = new HandshakeState({
    initiator: false,
    prologue: PROLOGUE,
    s: responder,
  });
  r.readMessage(first.writeMessage(text("one")).message);
  const answer = r.writeMessage(text("for one"));
  const second = start();
  second.writeMessage(text("two"));
  assert.throws(() => second.readMessage(answer.message), NoiseError);
});

it("refuses a handshake whose prologue differs", () => {
  const initiator = generateKeyPair();
  const responder = generateKeyPair();
  const i = new HandshakeState({
    initiator: true,
    prologue: text("sm-relay:a>b"),
    s: initiator,
    rs: responder.publicKey,
  });
  const r = new HandshakeState({
    initiator: false,
    prologue: text("sm-relay:a>c"),
    s: responder,
  });
  assert.throws(
    () => r.readMessage(i.writeMessage(text("hi")).message),
    NoiseError,
  );
});

it("refuses messages out of turn, and a replayed answer", () => {
  const initiator = generateKeyPair();
  const responder = generateKeyPair();
  const i = new HandshakeState({
    initiator: true,
    prologue: PROLOGUE,
    s: initiator,
    rs: responder.publicKey,
  });
  const r = new HandshakeState({
    initiator: false,
    prologue: PROLOGUE,
    s: responder,
  });
  assert.throws(() => r.writeMessage(text("first?")), NoiseError);
  const first = i.writeMessage(text("hi")).message;
  assert.throws(() => i.writeMessage(text("again")), NoiseError);
  r.readMessage(first);
  assert.throws(() => r.readMessage(first), NoiseError);
  const answer = r.writeMessage(text("ok")).message;
  i.readMessage(answer);
  assert.throws(() => i.readMessage(answer), NoiseError);
});

it("refuses a tampered, replayed or reordered frame without spending the nonce", () => {
  const { initiatorSide, responderSide } = handshake();
  const ad = new Uint8Array(0);
  const one = initiatorSide.send.encryptWithAd(ad, text("one"));
  const two = initiatorSide.send.encryptWithAd(ad, text("two"));

  const tampered = one.slice();
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  assert.throws(
    () => responderSide.receive.decryptWithAd(ad, tampered),
    NoiseError,
  );
  // Out of order: two arrives where one is due.
  assert.throws(() => responderSide.receive.decryptWithAd(ad, two), NoiseError);
  // Neither failure moved the counter, so one still reads, then two.
  assert.deepEqual(responderSide.receive.decryptWithAd(ad, one), text("one"));
  assert.deepEqual(responderSide.receive.decryptWithAd(ad, two), text("two"));
  // A frame read once does not read again.
  assert.throws(() => responderSide.receive.decryptWithAd(ad, two), NoiseError);
});

it("carries a frame at the device link's cap, and bounds handshake messages", () => {
  const { initiatorSide, responderSide } = handshake();
  const ad = new Uint8Array(0);
  // MAX_INBOUND_FRAME_BYTES on the device link (host/socket/server.ts).
  const frame = new Uint8Array(1 << 20).map((_, index) => index % 251);
  const sealed = initiatorSide.send.encryptWithAd(ad, frame);
  assert.equal(sealed.length, frame.length + 16);
  assert.deepEqual(responderSide.receive.decryptWithAd(ad, sealed), frame);

  const i = new HandshakeState({
    initiator: true,
    prologue: PROLOGUE,
    s: generateKeyPair(),
    rs: generateKeyPair().publicKey,
  });
  assert.throws(() => i.writeMessage(new Uint8Array(65535)), NoiseError);
});

it("refuses to seal or open once a direction's nonce runs out", () => {
  const { initiatorSide, responderSide } = handshake();
  const ad = new Uint8Array(0);
  // The counter's last value, as if that many frames had gone by.
  Reflect.set(initiatorSide.send, "n", Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => initiatorSide.send.encryptWithAd(ad, text("x")),
    NoiseError,
  );
  // A frame that does authenticate at that nonce, sealed with the
  // direction's own key, is still refused.
  Reflect.set(responderSide.receive, "n", Number.MAX_SAFE_INTEGER);
  const key = Reflect.get(responderSide.receive, "k") as Uint8Array;
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Number.MAX_SAFE_INTEGER % 2 ** 32, true);
  view.setUint32(8, Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 32), true);
  const authentic = chacha20poly1305(key, nonce, ad).encrypt(text("x"));
  assert.throws(
    () => responderSide.receive.decryptWithAd(ad, authentic),
    NoiseError,
  );
});

it("stores a device key as base64url and gets the same pair back", () => {
  const key = newDeviceKey();
  assert.match(key.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(key.privateKey, /^[A-Za-z0-9_-]{43}$/);
  const pair = deviceKeyPair(key.privateKey);
  assert.equal(toBase64Url(pair.publicKey), key.publicKey);
  assert.deepEqual(
    fromBase64Url(toBase64Url(pair.privateKey)),
    pair.privateKey,
  );
});
