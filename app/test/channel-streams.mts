// Durable proof for the duplex adapter on a byte channel
// (host/socket/channelStreams.ts over shared/ipc/socket/channels.ts):
// two muxes wired back to back, one end bridged to a duplex that never
// closes on its own, so the channel alone has to say when it is gone.
// Whichever side ends first, the adapter's onClosed fires once both
// directions have ended. A mirror's serve child is stopped and its
// serving entry dropped from that callback (host/ipc/modules/mirror.ts),
// and when the far end ended first it once waited on a duplex close
// that never came.
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

// The near end bridged to a duplex with no autoDestroy, so its 'close'
// never fires and only the channel can finish the adapter. The peer's
// end is a plain endpoint that records the near end's END.
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
  let closed = 0;
  bridgeDuplexToChannel(
    duplex,
    (endpoint) => near.attach(channelId, endpoint),
    {
      onClosed: () => {
        closed += 1;
      },
    },
  );
  let peerSawEnd = false;
  const peer = far.attach(channelId, {
    onData: (_data, consumed) => consumed(),
    onEnd: () => {
      peerSawEnd = true;
    },
    onReset: () => {},
    onWritable: () => {},
  });
  return {
    duplex,
    peer,
    closed: () => closed,
    peerSawEnd: () => peerSawEnd,
  };
}

// The duplex's 'end' is emitted on a later tick than its push(null).
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  console.log("channel-streams proof\n");

  await check(
    "the far end ending first, then the peer: onClosed fires on the peer's end",
    async () => {
      const link = bridged();
      link.duplex.push(null);
      await tick();
      assert.ok(link.peerSawEnd(), "the duplex's end must reach the peer");
      assert.equal(link.closed(), 0, "only one direction has ended");
      link.peer.end();
      assert.equal(link.closed(), 1);
    },
  );

  await check(
    "the peer ending first, then the far end: onClosed fires on the far end's end",
    async () => {
      const link = bridged();
      link.peer.end();
      assert.equal(link.closed(), 0, "only one direction has ended");
      link.duplex.push(null);
      await tick();
      assert.equal(link.closed(), 1);
    },
  );

  done();
}

main().catch(fail);
