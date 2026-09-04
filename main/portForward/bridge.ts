// One local socket bridged onto a byte channel of a peer's direct
// session (shared/ipc/socket/channels.ts), shared by the port-forward
// engine and the mirror gateway (main/mirror/gateway.ts). The caller
// supplies the OPEN: a port forward asks the peer to dial a loopback
// port, a mirror stream asks it to spawn `file-sync serve`; from the
// first byte on, a channel is a channel.
//
// Order is the point. The channel id is minted here; the local end is
// attached on the peer session FIRST, so the peer's first bytes always
// find it; the local socket stays paused until the open resolved, so
// this side's first bytes never reach the peer before ITS end is
// attached (the host attaches before answering). An open that fails
// resets the channel and destroys the socket. From then on the adapter
// (host/socket/channelStreams.ts) carries bytes, ends and resets both
// ways with credit-based backpressure, so a slow local consumer pauses
// the peer's source and the reverse.
import type { Socket } from "node:net";
import type { ChannelHandle, ChannelMux } from "@shared/ipc/socket/channels";
import { mintHexId } from "@host/lib/idleRegistry";
import { bridgeDuplexToChannel } from "@host/socket/channelStreams";

// How a caller reaches a peer's channels: the session's multiplexer,
// resolving once the direct session exists (joining an in-flight
// keeper dial), rejecting when there is none.
export type PeerChannels = () => Promise<Pick<ChannelMux, "attach" | "has">>;

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
    // land earlier; both users of the gateway speak first from this
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
  // Nagle would batch small local writes against the wire, mirroring
  // the host side's reasoning.
  socket.setNoDelay(true);
  // An explicit pause holds through the adapter attaching its data
  // listener; resumed below once the far end is open.
  socket.pause();
  // 'close' always follows 'error'; the listener must exist or node
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
    let mux: Awaited<ReturnType<PeerChannels>>;
    try {
      mux = await opts.channels();
    } catch (error) {
      if (!dead) opts.onOpenFailed?.(error);
      destroy();
      return;
    }
    if (dead) return;
    handle = bridgeDuplexToChannel(
      socket,
      (endpoint) => mux.attach(channelId, endpoint),
      { onClosed: reportClosed },
    );
    try {
      await opts.open(channelId);
    } catch (error) {
      if (!dead) opts.onOpenFailed?.(error);
      destroy();
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
