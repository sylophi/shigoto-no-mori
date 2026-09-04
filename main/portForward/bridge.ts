// One local socket bridged onto a byte channel of a peer's direct
// session (shared/ipc/socket/channels.ts), shared by the port-forward
// engine and the mirror gateway (main/mirror/gateway.ts). The caller
// supplies the OPEN: a port forward asks the peer to dial a loopback
// port, a mirror stream asks it to spawn `file-sync serve`. From the
// first byte on, a channel is a channel.
//
// Order is the point. The channel id is minted here. The local end is
// attached on the peer session FIRST, so the peer's first bytes always
// find it. The local socket stays paused until the open resolved, so
// this side's first bytes never reach the peer before ITS end is
// attached (the host attaches before answering). An open that fails
// resets the channel and destroys the socket. From then on the adapter
// (host/socket/channelStreams.ts) carries bytes, ends and resets both
// ways with credit-based backpressure, so a slow local consumer pauses
// the peer's source and the reverse.
import type { Server, Socket } from "node:net";
import type { ChannelHandle, ChannelMux } from "@shared/ipc/socket/channels";
import { mintHexId } from "@host/lib/idleRegistry";
import { bridgeDuplexToChannel } from "@host/socket/channelStreams";

// How a caller reaches a peer's channels: the session's multiplexer,
// resolving once the direct session exists (joining an in-flight
// keeper dial), rejecting when there is none.
export type PeerChannels = () => Promise<Pick<ChannelMux, "attach" | "has">>;

// How long a refused open's socket may linger for the peer to read the
// answer and close before it is destroyed.
const FAILED_OPEN_LINGER_MS = 1_000;

// Binds a listener on loopback (port 0 for an ephemeral one) and
// resolves the bound port, releasing the handle on any failure (an
// EADDRINUSE on an explicit port must not leak an unbound server).
// Loopback only, on both users: a forward is for THIS machine's
// processes and the gateway for this machine's daemon, never a
// listener other hosts can reach.
export function listenLoopback(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("listener bound without a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

export type BridgedConn = {
  readonly channelId: string;
  // Tears the conn down: the channel is reset and the local socket
  // destroyed.
  destroy: () => void;
};

export function bridgeSocket(
  socket: Socket,
  opts: {
    channels: PeerChannels;
    // Opens the far end on the peer under the minted channel id.
    open: (channelId: string) => Promise<void>;
    // Bytes the caller already read off the socket before handing it
    // over (a gateway's leftover after its preface line). Sent first,
    // once the far end is open.
    carried?: Buffer;
    // Runs once the far end is open and before any local byte is sent,
    // so a line written to the socket here precedes the stream. The
    // gateway's "ok" answer rides this. (A peer byte can in principle
    // land earlier. Both users of the gateway speak first from this
    // side, so none does.)
    onOpened?: () => void;
    // Runs when the open rejected, before the socket is destroyed, so
    // an answer can still be written to it.
    onOpenFailed?: (error: unknown) => void;
    // Runs exactly once, when the conn is gone (any cause).
    onClosed?: () => void;
  },
): BridgedConn {
  const channelId = mintHexId();
  let handle: ChannelHandle | null = null;
  let dead = false;
  let closedReported = false;
  const reportClosed = (): void => {
    if (closedReported) return;
    closedReported = true;
    opts.onClosed?.();
  };
  const destroy = (): void => {
    if (dead) return;
    dead = true;
    handle?.reset();
    socket.destroy();
    reportClosed();
  };
  // An open that failed: the caller may still write its answer line
  // (the gateway's "error <why>"), so the socket is ENDED rather than
  // destroyed, which flushes what is queued before the FIN. A peer
  // that does not close in turn is destroyed shortly after.
  const failOpen = (error: unknown): void => {
    if (dead) return;
    dead = true;
    handle?.reset();
    opts.onOpenFailed?.(error);
    socket.end();
    const killer = setTimeout(() => socket.destroy(), FAILED_OPEN_LINGER_MS);
    killer.unref?.();
    socket.once("close", () => clearTimeout(killer));
    reportClosed();
  };
  // Nagle would batch small local writes against the wire, mirroring
  // the host side's reasoning.
  socket.setNoDelay(true);
  // An explicit pause holds through the adapter attaching its data
  // listener. Resumed below once the far end is open.
  socket.pause();
  // 'close' always follows 'error'. The listener must exist or node
  // treats the socket error as an uncaught throw.
  socket.on("error", () => {});
  socket.on("close", () => {
    if (!dead) {
      dead = true;
      handle?.reset();
      reportClosed();
    }
  });

  void (async () => {
    // Every step up to the open can fail: no session, a session that
    // died between the lookup and the attach (attach throws on a dead
    // mux), or the peer refusing. All of them end in failOpen.
    try {
      const mux = await opts.channels();
      if (dead) return;
      handle = bridgeDuplexToChannel(
        socket,
        (endpoint) => mux.attach(channelId, endpoint),
        { onClosed: reportClosed },
      );
      await opts.open(channelId);
    } catch (error) {
      failOpen(error);
      return;
    }
    if (dead) return;
    opts.onOpened?.();
    if (opts.carried !== undefined && opts.carried.length > 0) {
      // Out of credit already (not in practice: the window is 4 MiB):
      // stay paused, the adapter resumes on the peer's credit.
      if (!handle.write(opts.carried)) return;
    }
    socket.resume();
  })();

  return { channelId, destroy };
}
