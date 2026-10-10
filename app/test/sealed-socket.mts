// Proof for the device link's sealed socket (shared/remote/sealedSocket.ts)
// over an in-memory socket pair, so every frame on the wire can be read,
// held back, tampered with or replayed: both ends authenticated, frames
// both ways as ciphertext, a refused ticket, a key other than the
// roster's on either end, a replayed first frame, a tampered and a
// reordered frame, and a frame at the link's cap.
//
// Run: pnpm test sealed-socket.
import assert from "node:assert/strict";
import type * as Socket from "effect/socket/Socket";
import { it } from "vitest";
import { generateKeyPair, type KeyPair } from "../shared/crypto/noise.ts";
import {
  CLOSE_HANDSHAKE_FAILED,
  sealDialer,
  sealListener,
} from "../shared/remote/sealedSocket.ts";
import { waitFor } from "./lib/checkKit.mts";

type Listener = (event: Socket.WebSocketEvent) => void;

// One end of an in-memory socket pair. `wire` holds every frame this
// end sent, and `tap` may rewrite or drop one on its way.
class FakeEnd implements Socket.WebSocketLike {
  readyState = 0;
  peer!: FakeEnd;
  readonly wire: Uint8Array[] = [];
  tap: (frame: Uint8Array) => Uint8Array | null = (frame) => frame;
  closedWith: number | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Socket.WebSocketEvent);
    }
  }
  send(data: string | Uint8Array): void {
    assert.ok(data instanceof Uint8Array, "a text frame on the wire");
    this.wire.push(data);
    const frame = this.tap(data);
    if (frame === null) return;
    const copy = frame.slice();
    queueMicrotask(() => this.peer.emit("message", { data: copy.buffer }));
  }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.closedWith = code;
    for (const end of [this, this.peer]) {
      end.readyState = 3;
      queueMicrotask(() => end.emit("close", { code }));
    }
  }
}

function pair(): [FakeEnd, FakeEnd] {
  const a = new FakeEnd();
  const b = new FakeEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function open(ends: FakeEnd[]): void {
  for (const end of ends) {
    end.readyState = 1;
    end.emit("open", {});
  }
}

// A sealed socket's frames as it delivers them.
function inbox(socket: Socket.WebSocketLike) {
  const frames: Uint8Array[] = [];
  let opened = false;
  socket.addEventListener("open", () => {
    opened = true;
  });
  socket.addEventListener("message", (event) => {
    frames.push((event as { data: Uint8Array }).data);
  });
  return { frames, opened: () => opened };
}

const text = (value: string) => new TextEncoder().encode(value);

type Setup = {
  dialerKey?: KeyPair;
  // The key the roster holds for the dialer, which the listener checks.
  rosterDialerKey?: Uint8Array;
  // The key the dialer seals to, the roster's for the listener.
  rosterListenerKey?: Uint8Array;
  tickets?: Set<string>;
  ticket?: string;
};

function connect(setup: Setup = {}) {
  const dialerKey = setup.dialerKey ?? generateKeyPair();
  const listenerKey = generateKeyPair();
  const tickets = setup.tickets ?? new Set(["smpt_good"]);
  const refusals: string[] = [];
  const [dialerWire, listenerWire] = pair();
  const listener = sealListener(listenerWire, {
    localKey: listenerKey,
    // Single use, like the host's ticket store.
    admit: async (ticket) =>
      tickets.delete(ticket)
        ? (setup.rosterDialerKey ?? dialerKey.publicKey)
        : null,
    refused: (reason) => refusals.push(reason),
  });
  const dialer = sealDialer(dialerWire, {
    ticket: setup.ticket ?? "smpt_good",
    localKey: dialerKey,
    remoteKey: setup.rosterListenerKey ?? listenerKey.publicKey,
  });
  const dialerIn = inbox(dialer);
  const listenerIn = inbox(listener);
  open([dialerWire, listenerWire]);
  return {
    dialer,
    listener,
    dialerIn,
    listenerIn,
    dialerWire,
    listenerWire,
    refusals,
    listenerKey,
    dialerKey,
    tickets,
  };
}

const established = (link: ReturnType<typeof connect>) =>
  waitFor(
    () => link.dialerIn.opened() && link.listenerIn.opened(),
    "both ends to open",
  );

it("opens both ends and carries frames each way, as ciphertext on the wire", async () => {
  const link = connect();
  // Connecting until the handshake is done.
  assert.equal(link.dialer.readyState, 0);
  await established(link);
  assert.equal(link.dialer.readyState, 1);
  link.dialer.send(text("up, in the clear"));
  link.listener.send(text("down, in the clear"));
  await waitFor(
    () =>
      link.listenerIn.frames.length === 1 && link.dialerIn.frames.length === 1,
    "a frame each way",
  );
  assert.deepEqual(link.listenerIn.frames[0], text("up, in the clear"));
  assert.deepEqual(link.dialerIn.frames[0], text("down, in the clear"));
  const onWire = [...link.dialerWire.wire, ...link.listenerWire.wire].map(
    (frame) => Buffer.from(frame).toString("latin1"),
  );
  assert.ok(onWire.every((frame) => !frame.includes("in the clear")));
  // The ticket rides in clear in the first frame, and nothing else does.
  assert.ok(onWire[0]?.includes("smpt_good"));
  // A frame grows by the tag alone.
  assert.equal(
    link.dialerWire.wire.at(-1)?.length,
    text("up, in the clear").length + 16,
  );
});

it("refuses a ticket the listener does not hold, before any crypto", async () => {
  const link = connect({ ticket: "smpt_unknown" });
  await waitFor(() => link.listenerWire.closedWith !== null, "the close");
  assert.equal(link.listenerWire.closedWith, CLOSE_HANDSHAKE_FAILED);
  assert.deepEqual(link.refusals, ["the ticket was refused"]);
  assert.equal(link.dialerIn.opened(), false);
});

it("refuses a dialer whose key is not the roster's for the ticket's device", async () => {
  const link = connect({ rosterDialerKey: generateKeyPair().publicKey });
  await waitFor(() => link.refusals.length === 1, "the refusal");
  assert.deepEqual(link.refusals, ["a key other than the roster's"]);
  assert.equal(link.dialerIn.opened(), false);
  assert.equal(link.listenerIn.opened(), false);
});

it("refuses a dialer that sealed to a key the listener does not hold", async () => {
  const link = connect({ rosterListenerKey: generateKeyPair().publicKey });
  await waitFor(() => link.refusals.length === 1, "the refusal");
  assert.deepEqual(link.refusals, ["the first message did not open"]);
  assert.equal(link.dialerIn.opened(), false);
});

it("refuses a replayed first frame: its ticket is spent, and a fresh ticket does not open it", async () => {
  const tickets = new Set(["smpt_good"]);
  const first = connect({ tickets });
  await established(first);
  const recorded = first.dialerWire.wire[0];
  assert.ok(recorded !== undefined);

  // The same frame on a new socket to the same listener key: the ticket
  // is single use.
  const refusals: string[] = [];
  const replay = (ticketsNow: Set<string>) => {
    const [attacker, listenerWire] = pair();
    const listener = sealListener(listenerWire, {
      localKey: first.listenerKey,
      admit: async (ticket) =>
        ticketsNow.delete(ticket) ? first.dialerKey.publicKey : null,
      refused: (reason) => refusals.push(reason),
    });
    const listenerIn = inbox(listener);
    open([attacker, listenerWire]);
    attacker.send(recorded);
    return { attacker, listenerWire, listenerIn };
  };
  replay(tickets);
  await waitFor(() => refusals.length === 1, "the refusal");
  assert.deepEqual(refusals, ["the ticket was refused"]);

  // Even were the ticket good again, the listener's answer opens only
  // for the dialer's ephemeral key, which the replayer does not hold:
  // nothing it can send afterwards authenticates.
  const second = replay(new Set(["smpt_good"]));
  await waitFor(() => second.listenerIn.opened(), "the listener to answer");
  second.attacker.send(text("a forged frame"));
  await waitFor(() => second.listenerWire.closedWith !== null, "the close");
  assert.equal(second.listenerWire.closedWith, CLOSE_HANDSHAKE_FAILED);
  assert.equal(second.listenerIn.frames.length, 0);
});

it("closes on a tampered frame and on a reordered one", async () => {
  const tampered = connect();
  await established(tampered);
  tampered.dialerWire.tap = (frame) => {
    const copy = frame.slice();
    copy[0] = (copy[0] ?? 0) ^ 1;
    return copy;
  };
  tampered.dialer.send(text("one"));
  await waitFor(() => tampered.listenerWire.closedWith !== null, "the close");
  assert.equal(tampered.listenerWire.closedWith, CLOSE_HANDSHAKE_FAILED);
  assert.equal(tampered.listenerIn.frames.length, 0);

  const reordered = connect();
  await established(reordered);
  const held: Uint8Array[] = [];
  reordered.dialerWire.tap = (frame) => {
    held.push(frame);
    return null;
  };
  reordered.dialer.send(text("one"));
  reordered.dialer.send(text("two"));
  reordered.dialerWire.tap = (frame) => frame;
  // Two before one.
  for (const frame of held.toReversed()) {
    reordered.listenerWire.emit("message", { data: frame.slice().buffer });
  }
  await waitFor(() => reordered.listenerWire.closedWith !== null, "the close");
  assert.equal(reordered.listenerIn.frames.length, 0);
});

it("carries a frame at the link's cap", async () => {
  const link = connect();
  await established(link);
  const frame = new Uint8Array(1 << 20).map((_, index) => index % 251);
  link.dialer.send(frame);
  await waitFor(() => link.listenerIn.frames.length === 1, "the frame");
  assert.deepEqual(link.listenerIn.frames[0], frame);
});
