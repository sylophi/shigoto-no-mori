// Durable proof for the duplex adapter on a byte channel
// (host/socket/channelStreams.ts over shared/ipc/socket/channels.ts):
// onClosed fires once both directions end, whichever ends first, with a
// duplex that never closes on its own. A mirror's serve child is
// stopped and its serving entry dropped from that callback
// (host/ipc/modules/mirror.ts).
//
// Runs under test/lib/register-ts-alias.mts so the app's TypeScript
// imports resolve. Run: pnpm test channel-streams.
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { mintHexId } from "@host/lib/hexId";
import { bridgeDuplexToChannel } from "@host/socket/channelStreams";
import { type ChannelMux, createChannelMux } from "@shared/ipc/socket/channels";
import { makeProof } from "./lib/checkKit.mts";

const { check, done, fail } = makeProof("channel-streams proof");

// Two muxes whose frames reach each other synchronously. The bridged
// side's duplex has no autoDestroy, so its 'close' never fires and only
// the channel can finish the adapter. The peer's side is a plain
// endpoint.
function bridged() {
  const bridgeSide: ChannelMux = createChannelMux({
    send: (frame) => void peerSide.handleFrame(frame),
  });
  const peerSide: ChannelMux = createChannelMux({
    send: (frame) => void bridgeSide.handleFrame(frame),
  });
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
    (endpoint) => bridgeSide.attach(channelId, endpoint),
    {
      onClosed: () => {
        state.closed += 1;
      },
    },
  );
  const peer = peerSide.attach(channelId, {
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

async function main() {
  console.log("channel-streams proof\n");

  await check(
    "the duplex ending first, then the peer: onClosed fires on the peer's end",
    async () => {
      const { duplex, peer, state } = bridged();
      duplex.push(null);
      await tick();
      assert.ok(state.peerSawEnd, "the duplex's end must reach the peer");
      assert.equal(state.closed, 0, "only one direction has ended");
      peer.end();
      assert.equal(state.closed, 1);
    },
  );

  await check(
    "the peer ending first, then the duplex: onClosed fires on the duplex's end",
    async () => {
      const { duplex, peer, state } = bridged();
      peer.end();
      assert.equal(state.closed, 0, "only one direction has ended");
      duplex.push(null);
      await tick();
      assert.equal(state.closed, 1);
    },
  );

  done();
}

main().catch(fail);
