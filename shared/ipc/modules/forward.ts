import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { PortNumberSchema } from "@shared/schemas";

// Byte streams to a peer (v2 step 8, reworked onto byte channels): a
// forwarded TCP connection or the file-sync engine's mirror stream
// crosses the direct websocket as raw binary channel frames
// (shared/ipc/socket/channels.ts), multiplexed beside the JSON
// invokes. This contract is only the two OPENS: the caller mints a
// channel id, attaches its end of the channel on its own transport
// first, then invokes open, and the host attaches the far end (a
// loopback dial, or a fresh `file-sync serve` child) under that id
// before answering. From then on bytes, ends and resets ride the
// channel itself, with credit-based backpressure end to end, and no
// contract verb is involved again. This is the HOST side a remote
// peer drives; the client half is main/portForward/bridge.ts.
//
// Both verbs are {remote:true, mutating:true}: the whole surface rides
// the per-peer command grant, fail-closed, and the LAN wire (read-only
// by policy) refuses it outright. open dials 127.0.0.1 only, because
// the feature IS reaching the remote machine's own loopback dev
// server, never a hop beyond it. Both set movesHostState:false: an
// open changes nothing a remote viewer caches (the mirror surface has
// its own changed broadcast).

// Channel ids are CLIENT-minted (shared/ipc/hexId.ts pins the shape):
// the caller attaches its endpoint under the id before the open, so
// the host's first bytes always find it. The host refuses an id
// already attached on that connection.
const ChannelIdSchema = HexId32Schema;

// The host's coded refusals, as the exact message texts the client
// side matches on (the UI's inline wording). Electron IPC and the
// device wires preserve only the message string, so the marker IS the
// message: mint and match through these, never a literal.
// connect-failed is a prefix, the rest are the whole message.
export const FORWARD_CONNECT_FAILED = "connect-failed";
export const FORWARD_TOO_MANY_CONNS = "too-many-conns";
export const FORWARD_NO_CHANNELS = "no-byte-channels";
export const FORWARD_CHANNEL_TAKEN = "channel-taken";

export const ForwardOpenPayloadSchema = z.strictObject({
  port: PortNumberSchema,
  channelId: ChannelIdSchema,
});

// The mirror stream's open (continuous worktree mirroring, file-sync/
// engine.go): the same conn shape as a port forward, but the far end
// is a `file-sync serve` child the host spawns for the named worktree
// instead of a loopback dial. send/poll/close are shared from there: a
// conn is a conn, whatever it carries.
export const ForwardOpenMirrorPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  worktreeId: z.string().regex(/^[0-9a-f]{12}$/),
  channelId: ChannelIdSchema,
});

export const forwardContract = defineContract("host", {
  open: invoke("forward:open", ForwardOpenPayloadSchema, z.void(), {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
  openMirror: invoke(
    "forward:openMirror",
    ForwardOpenMirrorPayloadSchema,
    z.void(),
    { remote: true, mutating: true, movesHostState: false },
  ),
});
