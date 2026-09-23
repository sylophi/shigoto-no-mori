// Host side of the port-forward open: a granted peer names a channel
// id it has already attached on its end, and this host dials the
// loopback port and attaches the socket under that id on the calling
// connection (the open guard and attach live in host/socket/
// channelStreams.ts, shared with the mirror stream's open). From then
// on the bytes ride the channel
// (shared/ipc/socket/channels.ts) with credit-based backpressure, and
// the far end lives exactly as long as the channel: a peer reset, a
// clean end from both sides, or the socket dying tears it down. No
// registry, no idle sweep, nothing to leak past the connection.
import { Effect } from "effect";
import { errorMessageOf, ForwardConnectFailed } from "@shared/errors";
import { forwardContract } from "@shared/ipc/modules/forward";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { dialLoopback } from "@host/lib/net";
import { hostAttempt, hostHandler } from "@host/runtime";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";

// How long a dial may sit unanswered before the open refuses.
const DIAL_TIMEOUT_MS = 5_000;

// Refusals are typed (shared/errors.ts): the client side and the UI
// match the tag, and an older client the message, which keeps the
// "connect-failed" prefix it matches on.

export const forwardHandlers: Handlers<typeof forwardContract, HandlerContext> =
  {
    open: hostHandler(({ port, channelId }, ctx: HandlerContext) =>
      Effect.gen(function* () {
        // The schema already pinned the range. Re-check so this handler
        // stays fail-closed even if it is ever reached off-contract.
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return yield* new ForwardConnectFailed({
            detail: "port out of range",
          });
        }
        yield* hostAttempt(() => requireChannels(ctx, channelId));
        // Loopback only, always: the feature is reaching the host's OWN
        // dev server, never using the host as a hop to its network. The
        // shared dial (host/lib/net.ts) tries 127.0.0.1 then ::1 and
        // carries its own deadline, so a hung dial cannot burn one of
        // the peer's in-flight slots forever.
        //
        // Uninterruptible from the dial to the attach: a dial the caller
        // walked away from would otherwise connect later to a socket
        // nobody holds. Bounded by the dial's own deadline, and a socket
        // that lands after the caller left is destroyed by the attach's
        // re-check of the connection, not leaked.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const socket = yield* hostAttempt(() =>
              dialLoopback(port, DIAL_TIMEOUT_MS),
            ).pipe(
              Effect.mapError(
                (error) =>
                  new ForwardConnectFailed({ detail: errorMessageOf(error) }),
              ),
            );
            // Nagle batches small writes against the wire's round trips,
            // so keystrokes and small frames must not wait on it.
            socket.setNoDelay(true);
            yield* hostAttempt(() => attachFarEnd(ctx, channelId, socket));
          }),
        );
        return undefined;
      }),
    ),
  };
