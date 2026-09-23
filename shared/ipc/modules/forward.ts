import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { PortNumberZod } from "@shared/schemas";

// Port forwarding over byte channels: a
// forwarded TCP connection crosses the direct websocket as raw binary
// channel frames (shared/ipc/socket/channels.ts), multiplexed beside
// the JSON invokes. This contract is only the OPEN: the caller mints a
// channel id, attaches its end of the channel on its own transport
// first, then invokes open, and the host dials the loopback port and
// attaches the socket under that id before answering. From then on
// bytes, ends and resets ride the channel itself, with credit-based
// backpressure end to end. The mirror stream is the other byte-stream
// open (mirror:openStream), on the same channel layer. This is the HOST
// side a remote peer drives. The client half is
// main/core/portForward/bridge.ts.
//
// {remote:true, mutating:true}: the surface rides the per-peer command
// grant, fail-closed, and the LAN wire (read-only by policy) refuses
// it outright. open dials 127.0.0.1 only, because the feature IS
// reaching the remote machine's own loopback dev server, never a hop
// beyond it. movesHostState:false: an open changes nothing a remote
// viewer caches.

// Channel ids are CLIENT-minted (shared/ipc/hexId.ts pins the shape):
// the caller attaches its endpoint under the id before the open, so
// the host's first bytes always find it. The host refuses an id
// already attached on that connection.
const ChannelIdSchema = HexId32Schema;

// The host's refusals are typed errors in shared/errors.ts:
// ForwardConnectFailed when the dial finds nothing on the port (the
// engine's start probe lets that one through), ChannelOpenRefused from
// the channel layer (the forward UI words too-many-conns inline).

const ForwardOpenPayloadSchema = z.strictObject({
  port: PortNumberZod,
  channelId: ChannelIdSchema,
});

export const forwardContract = defineContract("host", {
  open: invoke("forward:open", ForwardOpenPayloadSchema, z.void(), {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
});
