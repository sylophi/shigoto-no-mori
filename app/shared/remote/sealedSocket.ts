// The device link's socket, sealed end to end: a WebSocket that runs a
// Noise IK handshake (shared/crypto/noise.ts) over its first two frames
// and then carries every frame as one ChaCha20-Poly1305 message under a
// counter per direction. Effect's socket (Socket.fromWebSocket) is
// handed this in place of the platform socket on both ends, so the RPC
// client and server above it never see a clear byte on the wire.
//
// The dialer's first frame is the connect ticket in clear, then the
// handshake's first message; the ticket is the prologue too, so a
// handshake replayed under another ticket does not open. The listener
// spends the ticket before any crypto runs (`admit`), which names the
// device it was minted for and the key the hub's roster holds for it;
// the handshake then proves the dialer holds that key, and the dialer
// sealed to the listener's own key, which it took from the same roster.
// Until the handshake is done the socket reads as connecting, and any
// failure closes it.
//
// Pure: no node builtins, so the host, the desktop dialer and the web
// client run the same code.
import type * as Socket from "effect/socket/Socket";
import {
  HandshakeState,
  type KeyPair,
  NoiseError,
  type TransportCiphers,
} from "@shared/crypto/noise";

// The close code of a handshake that failed: a ticket refused, a key
// other than the roster's, a frame that did not authenticate.
export const CLOSE_HANDSHAKE_FAILED = 4004;

const EMPTY = new Uint8Array(0);
const utf8 = new TextEncoder();

function prologueOf(ticket: string): Uint8Array {
  return utf8.encode(`sm-link-v1:${ticket}`);
}

// The ticket's length as two bytes, the ticket, then the message.
function firstFrame(ticket: string, message: Uint8Array): Uint8Array {
  const ticketBytes = utf8.encode(ticket);
  const frame = new Uint8Array(2 + ticketBytes.length + message.length);
  new DataView(frame.buffer).setUint16(0, ticketBytes.length);
  frame.set(ticketBytes, 2);
  frame.set(message, 2 + ticketBytes.length);
  return frame;
}

function splitFirstFrame(
  frame: Uint8Array,
): { ticket: string; message: Uint8Array } | null {
  if (frame.length < 2) return null;
  const length = new DataView(frame.buffer, frame.byteOffset).getUint16(0);
  if (frame.length < 2 + length) return null;
  return {
    ticket: new TextDecoder().decode(frame.subarray(2, 2 + length)),
    message: frame.subarray(2 + length),
  };
}

// What noble and the frame builders return is backed by a plain
// ArrayBuffer, which the socket's send asks for by type.
const onWire = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

function sameKey(a: Uint8Array | null, b: Uint8Array): boolean {
  return (
    a !== null && a.length === b.length && a.every((byte, i) => byte === b[i])
  );
}

type Listener = (event: Socket.WebSocketEvent) => void;
type EventType = "open" | "message" | "error" | "close";

// The wrapper both ends share: events from the platform socket, opened
// once `established` is called, sealed and opened through `transport`.
function sealedSocket(ws: Socket.WebSocketLike): {
  socket: Socket.WebSocketLike;
  // Handshake frames, until the transport is set.
  onHandshakeFrame: (handler: (frame: Uint8Array) => void) => void;
  established: (transport: TransportCiphers) => void;
  fail: (reason: string) => void;
} {
  if ("binaryType" in ws) {
    (ws as { binaryType: string }).binaryType = "arraybuffer";
  }
  const listeners = new Map<EventType, Map<Listener, boolean>>();
  let transport: TransportCiphers | null = null;
  let handshakeFrame: ((frame: Uint8Array) => void) | null = null;
  let failed = false;

  const emit = (type: EventType, event: Socket.WebSocketEvent) => {
    const forType = listeners.get(type);
    if (forType === undefined) return;
    for (const [listener, once] of forType) {
      if (once) forType.delete(listener);
      listener(event);
    }
  };

  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    try {
      ws.close(CLOSE_HANDSHAKE_FAILED, reason);
    } catch {
      // Already closing.
    }
  };

  ws.addEventListener("message", (event) => {
    const frame = bytesOf((event as { data?: unknown }).data);
    if (frame === null || failed) return fail("a frame that is not binary");
    if (transport === null) {
      handshakeFrame?.(frame);
      return;
    }
    let opened: Uint8Array;
    try {
      opened = transport.receive.decryptWithAd(EMPTY, frame);
    } catch {
      return fail("a frame that did not authenticate");
    }
    emit("message", { ...event, data: opened } as Socket.WebSocketEvent);
  });
  ws.addEventListener("close", (event) => emit("close", event));
  ws.addEventListener("error", (event) => emit("error", event));

  const socket: Socket.WebSocketLike = {
    get readyState() {
      // Connecting until the handshake is done, then the platform's.
      return transport === null && ws.readyState === 1 ? 0 : ws.readyState;
    },
    addEventListener(type, listener, options) {
      const forType = listeners.get(type) ?? new Map<Listener, boolean>();
      forType.set(listener, options?.once === true);
      listeners.set(type, forType);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    send(data) {
      if (transport === null) throw new NoiseError("the handshake is not done");
      const plaintext = typeof data === "string" ? utf8.encode(data) : data;
      ws.send(onWire(transport.send.encryptWithAd(EMPTY, plaintext)));
    },
  };

  return {
    socket,
    onHandshakeFrame: (handler) => {
      handshakeFrame = handler;
    },
    established: (ciphers) => {
      transport = ciphers;
      emit("open", { type: "open" } as Socket.WebSocketEvent);
    },
    fail,
  };
}

// The dialer's end: sends the ticket and the first message once the
// platform socket opens, and reads as open once the listener's answer
// has opened.
export function sealDialer(
  ws: Socket.WebSocketLike,
  options: {
    readonly ticket: string;
    readonly localKey: KeyPair;
    // The key the hub's roster holds for the device being dialed.
    readonly remoteKey: Uint8Array;
  },
): Socket.WebSocketLike {
  const sealed = sealedSocket(ws);
  const handshake = new HandshakeState({
    initiator: true,
    prologue: prologueOf(options.ticket),
    s: options.localKey,
    rs: options.remoteKey,
  });
  const start = () => {
    ws.send(
      onWire(firstFrame(options.ticket, handshake.writeMessage(EMPTY).message)),
    );
  };
  if (ws.readyState === 1) start();
  else ws.addEventListener("open", start, { once: true });
  sealed.onHandshakeFrame((frame) => {
    try {
      const { transport } = handshake.readMessage(frame);
      if (transport === null) throw new NoiseError("the handshake is not done");
      sealed.established(transport);
    } catch {
      sealed.fail("the listener's answer did not open");
    }
  });
  return sealed.socket;
}

// The listener's end: spends the ticket, reads the dialer's first
// message, checks the key it proves is the roster's for the device the
// ticket was minted for, and answers. `admit` answers that key, or null
// for a ticket that is not good; `refused` hears every failure, for the
// listener's lockout and log.
export function sealListener(
  ws: Socket.WebSocketLike,
  options: {
    readonly localKey: KeyPair;
    readonly admit: (ticket: string) => Promise<Uint8Array | null>;
    readonly refused: (reason: string) => void;
  },
): Socket.WebSocketLike {
  const sealed = sealedSocket(ws);
  const refuse = (reason: string) => {
    options.refused(reason);
    sealed.fail(reason);
  };
  let started = false;
  sealed.onHandshakeFrame((frame) => {
    if (started) return refuse("a second first frame");
    started = true;
    const first = splitFirstFrame(frame);
    if (first === null) return refuse("a malformed first frame");
    void options.admit(first.ticket).then(
      (peerKey) => {
        if (peerKey === null) return refuse("the ticket was refused");
        const handshake = new HandshakeState({
          initiator: false,
          prologue: prologueOf(first.ticket),
          s: options.localKey,
        });
        try {
          handshake.readMessage(first.message);
          if (!sameKey(handshake.remoteStaticKey(), peerKey)) {
            return refuse("a key other than the roster's");
          }
          const { message, transport } = handshake.writeMessage(EMPTY);
          if (transport === null) {
            throw new NoiseError("the handshake is not done");
          }
          ws.send(onWire(message));
          sealed.established(transport);
        } catch {
          refuse("the first message did not open");
        }
      },
      () => refuse("the ticket check failed"),
    );
  });
  return sealed.socket;
}
