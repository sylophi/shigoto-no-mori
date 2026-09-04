// The one adapter between a node duplex stream and a byte channel
// (shared/ipc/socket/channels.ts). Every byte stream on the direct
// wire is bridged through here on both ends: the host's loopback
// socket or serve child's stdio (host/ipc/modules/forward.ts) and the
// client's accepted local socket (main/portForward/bridge.ts, the
// mirror gateway).
//
// Backpressure is the whole point of the shape:
//   - inbound bytes are written to the duplex and the channel's credit
//     is returned from the write CALLBACK, so a slow sink (a paused
//     TCP consumer, a busy serve child) holds credit back and the peer
//     pauses its source;
//   - outbound bytes are handed to the channel, and a false return
//     (credit spent) pauses the duplex until the channel says it is
//     writable again.
// A duplex 'end' ends the channel's direction; a duplex close or error
// resets whatever is left; a peer end ends the duplex; a peer reset
// destroys it.
import type { Duplex } from "node:stream";
import type {
  ChannelEndpoint,
  ChannelHandle,
} from "@shared/ipc/socket/channels";

export type DuplexChannelOpts = {
  // Bytes already read off the duplex before bridging (a gateway's
  // leftover after its preface line), sent first.
  carried?: Uint8Array;
  // Fires exactly once when the channel is gone for any reason: both
  // directions ended, either side reset, or the socket died.
  onClosed?: () => void;
};

export function bridgeDuplexToChannel(
  duplex: Duplex,
  attach: (endpoint: ChannelEndpoint) => ChannelHandle,
  opts: DuplexChannelOpts = {},
): ChannelHandle {
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    opts.onClosed?.();
  };
  let handle: ChannelHandle;
  const endpoint: ChannelEndpoint = {
    onData(data, consumed) {
      if (duplex.destroyed || duplex.writableEnded) {
        consumed();
        return;
      }
      duplex.write(
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        () => consumed(),
      );
    },
    onEnd() {
      if (!duplex.destroyed && !duplex.writableEnded) duplex.end();
      // With this side already ended too, the channel is complete and
      // the mux drops it; the duplex's own close follows.
      if (!handle.open) finish();
    },
    onReset() {
      duplex.destroy();
      finish();
    },
    onWritable() {
      duplex.resume();
    },
  };
  handle = attach(endpoint);
  if (opts.carried !== undefined && opts.carried.length > 0) {
    if (!handle.write(opts.carried)) duplex.pause();
  }
  duplex.on("data", (chunk: Buffer) => {
    if (!handle.open) return;
    if (!handle.write(chunk)) duplex.pause();
  });
  duplex.on("end", () => {
    handle.end();
    if (!handle.open) finish();
  });
  // 'close' always follows 'error'; the listener must exist or node
  // treats a stream error as an uncaught throw.
  duplex.on("error", () => {});
  duplex.on("close", () => {
    // A clean, fully ended channel is already gone (reset is a no-op
    // then); anything else is torn down.
    handle.reset();
    finish();
  });
  return handle;
}
