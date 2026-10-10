// The one adapter between a node duplex stream and a byte channel
// (shared/remote/channels.ts). Every byte stream on the device link is
// bridged through here on both ends: the host's loopback socket or
// serve child's stdio (host/ipc/modules/forward.ts) and the client's
// accepted local socket (host/portForward/bridge.ts, the mirror
// gateway).
//
// Backpressure is the whole point of the shape:
//   - inbound bytes are written to the duplex and taken from the
//     channel in the write CALLBACK, so a slow sink (a paused TCP
//     consumer, a busy serve child) holds the far end back,
//   - outbound bytes are handed to the channel, and a false return
//     (its window full) pauses the duplex until the channel says it is
//     writable again.
// A duplex 'end' ends the channel's direction, and the close that
// follows a clean end changes nothing: bytes the channel still holds
// keep flowing, and the channel completes once the peer ends too. Only
// a close WITHOUT a prior end (a destroy, an error) resets whatever is
// left. A peer end ends the duplex. A peer reset destroys it.
import type { Duplex } from "node:stream";
import type { ChannelEndpoint, ChannelHandle } from "@shigomori/contracts/link";
import { MAX_CHANNELS_PER_LINK } from "@shared/remote/link";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  CHANNEL_OPEN_NO_CHANNELS,
  CHANNEL_OPEN_TAKEN,
  CHANNEL_OPEN_TOO_MANY,
} from "@shigomori/contracts/channelRefusals";

export type DuplexChannelOpts = {
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
    },
    onReset() {
      duplex.destroy();
      finish();
    },
    onComplete: finish,
    onWritable() {
      duplex.resume();
    },
  };
  handle = attach(endpoint);
  duplex.on("data", (chunk: Buffer) => {
    if (!handle.open) return;
    if (!handle.write(chunk)) duplex.pause();
  });
  let endedCleanly = false;
  duplex.on("end", () => {
    endedCleanly = true;
    handle.end();
  });
  // 'close' always follows 'error'. The listener must exist or node
  // treats a stream error as an uncaught throw.
  duplex.on("error", () => {});
  duplex.on("close", () => {
    // After a clean end the channel finishes on its own terms (see the
    // header). A reset here would drop the bytes it still holds. An
    // abrupt close tears down whatever is left.
    if (!endedCleanly) handle.reset();
    finish();
  });
  return handle;
}

// The two halves of a byte-stream open on the host (forward:open,
// mirror:openStream). requireChannels runs BEFORE the handler does
// any work: the connection must carry channels at all (the shell's
// port does not), the caller's id must be free on it,
// and the cap must hold. attachFarEnd runs after the handler's awaits
// (a dial, a worktree lookup), re-checking everything that can have
// changed meanwhile: the connection may have died, the id may have
// been claimed, the cap may have filled. On any refusal the duplex is
// destroyed and the coded marker thrown, so a handler that spawned a
// process for the far end need only kill it on a throw. A channel the
// peer already reset comes back closed (see ChannelMux.attach), and
// the adapter tears the far end down through its ordinary close path.
export function requireChannels(
  ctx: HandlerContext,
  channelId: string,
): NonNullable<HandlerContext["channels"]> {
  const channels = ctx.channels;
  if (channels === undefined) throw new Error(CHANNEL_OPEN_NO_CHANNELS);
  if (channels.has(channelId) || ctx.connection.aborted) {
    throw new Error(CHANNEL_OPEN_TAKEN);
  }
  if (channels.size() >= MAX_CHANNELS_PER_LINK) {
    throw new Error(CHANNEL_OPEN_TOO_MANY);
  }
  return channels;
}

export function attachFarEnd(
  ctx: HandlerContext,
  channelId: string,
  duplex: Duplex,
  opts: DuplexChannelOpts = {},
): ChannelHandle {
  // A refused far end is destroyed below, before the adapter installed
  // its own error listener. A stream child's stdio raises on destroy.
  duplex.on("error", () => {});
  try {
    const channels = requireChannels(ctx, channelId);
    return bridgeDuplexToChannel(
      duplex,
      (endpoint) => channels.attach(channelId, endpoint),
      opts,
    );
  } catch (error) {
    duplex.destroy();
    throw error;
  }
}
