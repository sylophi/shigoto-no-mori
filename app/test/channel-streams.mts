// Durable proof for the duplex adapter on a byte channel
// (host/socket/channelStreams.ts over shared/ipc/socket/channels.ts):
// onClosed fires once both directions end, whichever ends first, with a
// duplex that never closes on its own. A mirror's serve child is
// stopped and its serving entry dropped from that callback
// (host/ipc/modules/mirror.ts). Beneath it, the mux reports a clean
// completion even when this side's end waited on credit.
//
// Runs under test/lib/register-ts-alias.mts so the app's TypeScript
// imports resolve. Run: pnpm test channel-streams.
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { mintHexId } from "@host/lib/hexId";
import { bridgeDuplexToChannel } from "@host/socket/channelStreams";
import {
  CHANNEL_WINDOW_BYTES,
  type ChannelMux,
  createChannelMux,
} from "@shared/ipc/socket/channels";
import { it } from "vitest";

// Two muxes whose frames reach each other synchronously.
function wiredMuxes(): { near: ChannelMux; far: ChannelMux } {
  const near: ChannelMux = createChannelMux({
    send: (frame) => void far.handleFrame(frame),
  });
  const far: ChannelMux = createChannelMux({
    send: (frame) => void near.handleFrame(frame),
  });
  return { near, far };
}

// The near side bridged to a duplex with no autoDestroy, so its 'close'
// never fires and only the channel can finish the adapter. The far side
// is a plain endpoint.
function bridged() {
  const { near, far } = wiredMuxes();
  const channelId = mintHexId();
  const duplex = new Duplex({
    autoDestroy: false,
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const state = { closed: 0, peerSawEnd: false };
  bridgeDuplexToChannel(
    duplex,
    (endpoint) => near.attach(channelId, endpoint),
    {
      onClosed: () => {
        state.closed += 1;
      },
    },
  );
  const peer = far.attach(channelId, {
    onData: (_data, consumed) => consumed(),
    onEnd: () => {
      state.peerSawEnd = true;
    },
    onReset: () => {},
    onWritable: () => {},
  });
  return { duplex, peer, state };
}

// The duplex's 'end' is emitted on a later tick than its push(null).
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

console.log("channel-streams proof\n");

it("the duplex ending first, then the peer: onClosed fires on the peer's end", async () => {
  const { duplex, peer, state } = bridged();
  duplex.push(null);
  await tick();
  assert.ok(state.peerSawEnd, "the duplex's end must reach the peer");
  assert.equal(state.closed, 0, "only one direction has ended");
  peer.end();
  assert.equal(state.closed, 1);
});

it("the peer ending first, then the duplex: onClosed fires on the duplex's end", async () => {
  const { duplex, peer, state } = bridged();
  peer.end();
  assert.equal(state.closed, 0, "only one direction has ended");
  duplex.push(null);
  await tick();
  assert.equal(state.closed, 1);
});

it("an end queued behind bytes waiting for credit: the channel completes once the credit lets them through", () => {
  const { near, far } = wiredMuxes();
  const channelId = mintHexId();
  let completed = 0;
  const sender = near.attach(channelId, {
    onData: (_data, consumed) => consumed(),
    onEnd: () => {},
    onReset: () => {},
    onWritable: () => {},
    onComplete: () => {
      completed += 1;
    },
  });
  const held: (() => void)[] = [];
  const receiver = far.attach(channelId, {
    onData: (_data, consumed) => held.push(consumed),
    onEnd: () => {},
    onReset: () => {},
    onWritable: () => {},
  });
  assert.equal(
    sender.write(new Uint8Array(CHANNEL_WINDOW_BYTES + 1)),
    false,
    "the byte past the window must wait for credit",
  );
  sender.end();
  receiver.end();
  assert.equal(completed, 0, "the end is still queued behind that byte");
  for (const consumed of held.splice(0)) consumed();
  assert.equal(completed, 1);
  assert.equal(sender.open, false);
});
