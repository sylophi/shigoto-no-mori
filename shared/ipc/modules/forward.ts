import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { ChunkB64Schema } from "@shared/relay/protocol";

// Port-forward wire protocol (v2 step 8, slice A): TCP bytes move
// between devices as chunked, grant-gated invoke/response calls over
// the existing device connection, exactly like the sync bundle
// transfer. Invoke/response ONLY, never pushes: responses to awaited
// invokes are reliable on the relay link, while pushes are droppable
// under backpressure (shared/relay/link.ts trySendPush), and a dropped
// frame in a TCP stream is corruption, not degradation. Chunks are
// RELAY_CHUNK_BYTES raw so their base64 form fits inside a res frame
// under MAX_RELAY_MESSAGE_BYTES (shared/relay/protocol.ts owns the
// arithmetic). The downlink is a long-poll (forward:poll) so
// server-initiated bytes flow without an uplink write first. This is
// the HOST side a remote peer drives. The client-side listener/engine
// lands in slice B.
//
// No call on this surface is retryable: poll is a destructive read and
// send is not idempotent, so a rejected or dropped call must tear the
// conn down, never be retried (a retried poll loses bytes, a retried
// send duplicates them). There is no half-close either: close destroys
// both directions, and a FIN from the local service ends the uplink
// too (send then refuses with conn-closed).
//
// Every verb is {remote:true, mutating:true}: the whole surface rides
// the per-peer command grant, fail-closed, and the LAN wire (read-only
// by policy) refuses it outright. open dials 127.0.0.1 only, because
// the feature IS reaching the remote machine's own loopback dev
// server, never a hop beyond it. All four also set
// movesHostState:false: shuttling bytes changes nothing a remote
// viewer caches, and without the opt-out an open forward would fire
// the registrar's cache ping (git:externalChange to every peer) on
// every poll and send resolution.

// connIds are host-minted (shared/ipc/hexId.ts pins the shape), so a
// peer can only replay an id it was given, never probe with crafted
// ones. ChunkB64Schema (shared/relay/protocol.ts) bounds BOTH
// directions (send payload and poll result), so an uplink write can
// never exceed what a downlink chunk may carry and vice versa.
const ConnIdSchema = HexId32Schema;

export const ForwardOpenPayloadSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
});

export const ForwardOpenResultSchema = z.strictObject({
  connId: ConnIdSchema,
});

export const ForwardSendPayloadSchema = z.strictObject({
  connId: ConnIdSchema,
  dataB64: ChunkB64Schema,
});

export const ForwardPollPayloadSchema = z.strictObject({
  connId: ConnIdSchema,
});

export const ForwardPollResultSchema = z.strictObject({
  dataB64: ChunkB64Schema,
  eof: z.boolean(),
});

export const ForwardClosePayloadSchema = z.strictObject({
  connId: ConnIdSchema,
});

export const forwardContract = defineContract("host", {
  open: invoke(
    "forward:open",
    ForwardOpenPayloadSchema,
    ForwardOpenResultSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  send: invoke("forward:send", ForwardSendPayloadSchema, z.void(), {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
  poll: invoke(
    "forward:poll",
    ForwardPollPayloadSchema,
    ForwardPollResultSchema,
    // A read in shape, but it moves loopback service bytes off the
    // host, so it rides the command grant with the rest of the surface.
    { remote: true, mutating: true, movesHostState: false },
  ),
  close: invoke("forward:close", ForwardClosePayloadSchema, z.void(), {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
});
