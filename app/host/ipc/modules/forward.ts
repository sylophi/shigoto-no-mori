// Host side of the port-forward open: a granted peer names a channel
// id it has already attached on its end, and this host dials the
// loopback port and attaches the socket under that id on the calling
// connection (the open guard and attach live in host/socket/
// channelStreams.ts, shared with the mirror stream's open). From then
// on the bytes ride the channel (shared/remote/channels.ts), each side
// pulled as fast as the other takes it, and the far end lives exactly
// as long as the channel: a peer reset, a clean end from both sides,
// or the link dropping tears it down. No
// registry, no idle sweep, nothing to leak past the connection.
import type { Socket } from "node:net";
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import {
  FORWARD_CONNECT_FAILED,
  forwardContract,
} from "@shigomori/contracts/modules/forward";
import type { HandlerContext } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import { dialLoopback } from "@host/lib/net";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";

// How long a dial may sit unanswered before the open refuses.
const DIAL_TIMEOUT_MS = 5_000;

// Error messages here are stable markers, not prose (the FORWARD_*
// constants beside the contract), which the client side and the UI
// match.

export const forwardHandlers: EffectHandlers<
  typeof forwardContract,
  HandlerContext
> = {
  open: ({ port, channelId }, ctx) =>
    Effect.tryPromise({
      try: () => open(port, channelId, ctx),
      catch: callFailureOf,
    }),
};

async function open(port: number, channelId: string, ctx: HandlerContext) {
  // The schema already pinned the range. Re-check so this handler
  // stays fail-closed even if it is ever reached off-contract.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${FORWARD_CONNECT_FAILED}: port out of range`);
  }
  requireChannels(ctx, channelId);
  // Loopback only, always: the feature is reaching the host's OWN
  // dev server, never using the host as a hop to its network. The
  // shared dial (host/lib/net.ts) tries 127.0.0.1 then ::1 and
  // carries its own deadline, so a hung dial cannot burn one of
  // the peer's in-flight slots forever.
  let socket: Socket;
  try {
    socket = await dialLoopback(port, DIAL_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`${FORWARD_CONNECT_FAILED}: ${errorMessageOf(error)}`, {
      cause: error,
    });
  }
  // Nagle batches small writes against the wire's round trips, so
  // keystrokes and small frames must not wait on it.
  socket.setNoDelay(true);
  attachFarEnd(ctx, channelId, socket);
}
