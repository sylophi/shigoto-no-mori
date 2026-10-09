// Durable proof for the duplex adapter on a byte channel
// (host/socket/channelStreams.ts), over a live device link
// (shared/remote/channels.ts, host/socket/channels.ts): onClosed fires
// once both directions end, whichever ends first, with a duplex that
// never closes on its own. A mirror's serve child is stopped and its
// serving entry dropped from that callback (host/ipc/modules/mirror.ts).
// Beneath it, a channel completes cleanly even when this side's end
// waited behind bytes the far end had not taken yet.
//
// Run: pnpm test channel-streams.
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { it } from "vitest";
import { mintHexId } from "@host/lib/hexId";
import { attachFarEnd } from "@host/socket/channelStreams";
import type { ChannelEndpoint } from "@shigomori/contracts/link";
import { CHANNEL_WINDOW_BYTES } from "@shared/remote/channels";
import type { HandlerContext } from "@shared/ipc/transport";
import { type Track, waitFor } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { dialListener, startDirectListener } from "./lib/directBoot.mts";

// A listener whose forward:open hands the far end to `open`, and a
// link to it.
async function linked(
  track: Track,
  open: (ctx: HandlerContext, channelId: string) => void,
) {
  const listener = await startDirectListener(track, {
    registerHandlers: (binding) => {
      binding.handle("forward:open", async (ctx, input) => {
        open(ctx, (input as { channelId: string }).channelId);
      });
    },
  });
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  const openChannel = async (endpoint: ChannelEndpoint) => {
    const channelId = mintHexId();
    const handle = connection.channels.attach(channelId, endpoint);
    await connection.transport.invoke("forward:open", { port: 1, channelId });
    return handle;
  };
  return { openChannel };
}

// The host's end bridged to a duplex with no autoDestroy, so its
// 'close' never fires and only the channel can finish the adapter. The
// dialer's end is a plain endpoint.
async function bridged(track: Track) {
  const duplex = new Duplex({
    autoDestroy: false,
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const state = { closed: 0, peerSawEnd: false };
  const { openChannel } = await linked(track, (ctx, channelId) => {
    attachFarEnd(ctx, channelId, duplex, {
      onClosed: () => {
        state.closed += 1;
      },
    });
  });
  const peer = await openChannel({
    onData: (_data, consumed) => consumed(),
    onEnd: () => {
      state.peerSawEnd = true;
    },
    onReset: () => {},
    onWritable: () => {},
  });
  return { duplex, peer, state };
}

it("the duplex ending first, then the peer: onClosed fires on the peer's end", async () => {
  const { duplex, peer, state } = await bridged(trackTest);
  duplex.push(null);
  await waitFor(() => state.peerSawEnd, "the duplex's end to reach the peer");
  assert.equal(state.closed, 0, "only one direction has ended");
  peer.end();
  await waitFor(() => state.closed === 1, "onClosed");
});

it("the peer ending first, then the duplex: onClosed fires on the duplex's end", async () => {
  const { duplex, peer, state } = await bridged(trackTest);
  peer.end();
  // The end crosses before the duplex's own.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.closed, 0, "only one direction has ended");
  duplex.push(null);
  await waitFor(() => state.closed === 1, "onClosed");
});

it("an end queued behind bytes the far end has not taken: the writer is told to pause, and the channel completes once those bytes are taken", async () => {
  const held: (() => void)[] = [];
  let farEnded = false;
  const { openChannel } = await linked(trackTest, (ctx, channelId) => {
    const channels = ctx.channels;
    assert.ok(channels !== undefined, "the link carries no channels");
    const handle = channels.attach(channelId, {
      onData: (_data, consumed) => held.push(consumed),
      onEnd: () => {
        farEnded = true;
        handle.end();
      },
      onReset: () => {},
      onWritable: () => {},
    });
  });
  let completed = 0;
  let writable = 0;
  const sender = await openChannel({
    onData: (_data, consumed) => consumed(),
    onEnd: () => {},
    onReset: () => assert.fail("the channel reset"),
    onWritable: () => {
      writable += 1;
    },
    onComplete: () => {
      completed += 1;
    },
  });
  assert.equal(
    sender.write(new Uint8Array(CHANNEL_WINDOW_BYTES + 1)),
    false,
    "past the window the writer must pause",
  );
  sender.end();
  await waitFor(() => held.length > 0, "the first piece to arrive");
  assert.equal(completed, 0, "the end is still queued behind those bytes");
  await waitFor(() => {
    for (const consumed of held.splice(0)) consumed();
    return farEnded;
  }, "every piece taken and the end through");
  await waitFor(() => completed === 1, "the channel to complete");
  assert.equal(writable, 1);
  assert.equal(sender.open, false);
});
