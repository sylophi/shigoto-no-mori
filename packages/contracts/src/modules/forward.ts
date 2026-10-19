import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { PortNumberSchema, VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// Only the open: the caller attaches its end of the channel first, then
// the host dials the loopback port and attaches the socket before
// answering. Bytes, ends and resets ride the channel. Dials 127.0.0.1
// only: the feature is the remote machine's own dev server, never a hop
// beyond it.

// Client-minted, so the host's first bytes always find the caller's end.
const ChannelIdSchema = HexId32Schema;

const ForwardOpenPayloadSchema = strict(
  Schema.Struct({
    port: PortNumberSchema,
    channelId: ChannelIdSchema,
  }),
);

export const forwardContract = defineContract(
  "forward",
  "host",
  invoke("open", ForwardOpenPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "reachServers",
  }),
);
