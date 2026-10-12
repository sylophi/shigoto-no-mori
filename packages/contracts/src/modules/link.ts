import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { VoidSchema } from "../schemas/void.ts";
import { strict } from "../schemas/strict.ts";

// The device link's own calls: the handshake every connection opens
// with, the liveness probe, and the byte channels that forwarded ports
// and mirror streams ride. Every other call on a link is a contract
// module's, served once the hello is accepted (app/host/socket/).
//
// Between devices the socket under these calls is sealed: the connect
// ticket and a Noise handshake open it, and every frame after is
// encrypted (app/shared/remote/sealedSocket.ts), so both ends know
// who the other is before the hello. The hello names the connection
// and supersedes the device's older links, so a dialer opens every
// candidate at once and says hello on one at a time. On the loopback,
// which never leaves the machine, the hello carries the host's token
// instead (app/host/socket/Loopback.ts).
//
// The hello carries the protocol version (protocol.ts). A host on
// another version refuses it with ProtocolVersionMismatchError.

const AppVersionSchema = Schema.String.check(Schema.isMaxLength(64));

// What kind of device dials: a desktop app, which holds one link to a
// host (a second supersedes the first: two app instances on one root),
// or a web client, one per browser profile, which holds a link per tab.
const DeviceKindSchema = Schema.Literals(["desktop", "web"]);
export type DeviceKind = typeof DeviceKindSchema.Type;

const HelloSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    deviceKind: DeviceKindSchema,
    // Minted by the dialer for this connection, so a host tells a web
    // device's tabs apart, and a connection dialing again replaces its
    // own stale link and no other.
    connectionId: HexId32Schema,
    appVersion: AppVersionSchema,
    protocolVersion: Schema.Int,
    // The loopback's token (loopback.json), compared by the host and
    // nothing else, so whatever a stale file holds is refused there. A
    // device link has none: its ticket opened the socket.
    token: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  }),
);

const WelcomeSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    appVersion: AppVersionSchema,
  }),
);

// A byte channel on the link, named by the id its opener minted before
// the call that attaches the far end (forward:open, mirror:openStream,
// sync:openSource, sync:receiveBundle).
const ChannelSchema = strict(Schema.Struct({ channelId: HexId32Schema }));

// The most one write carries, and one read answers. A writer splits
// larger pieces, and a read answers what the far end has queued, up to
// this. Small, so a channel's frames interleave finely with the link's
// other traffic: 32 KB is 13 ms on a 20 Mbit/s uplink.
export const CHANNEL_MAX_WRITE_BYTES = 32 * 1024;
export const CHANNEL_MAX_READ_BYTES = 32 * 1024;

// Each direction of a channel is numbered calls, from 0 per channel and
// direction, at most this many in flight (a window of 2 MiB); the far
// end answers them in that order and refuses one further ahead. How
// many a side keeps in flight below that is its own (the dialer sizes
// it to the link, shared/remote/channels.ts). A peer holds a bounded
// number of calls on each channel, which is why these leave the link's
// in-flight cap.
export const CHANNEL_CALLS_IN_FLIGHT = 64;

// A plain struct, where the link's other calls are strict: the binary
// layout carries only the fields it declares, and bytes have no JSON
// form a strict struct's could pass through.
const WriteSchema = Schema.Struct({
  channelId: HexId32Schema,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  data: Schema.Uint8Array.check(
    Schema.makeFilter((bytes) => bytes.byteLength <= CHANNEL_MAX_WRITE_BYTES),
  ),
});

const ReadSchema = strict(
  Schema.Struct({
    channelId: HexId32Schema,
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

// The far end's next bytes, once it has some: never empty while its
// direction is open, and empty once it ended. A reader asks for the
// next only once it has room for it, so a slow reader holds the far
// end back, and nothing it has not asked for ever waits on the socket.
const ReadBytesSchema = Schema.Uint8Array.check(
  Schema.makeFilter((bytes) => bytes.byteLength <= CHANNEL_MAX_READ_BYTES),
);

const link = { remote: true, gated: false } as const;

export const linkContract = defineContract(
  "link",
  "host",
  invoke("hello", HelloSchema, WelcomeSchema, link),
  // Answers at once: a probe of a link that may have died unseen.
  invoke("ping", VoidSchema, VoidSchema, link),
  invoke("read", ReadSchema, ReadBytesSchema, link),
  // Bytes to the far end. Answers once the far end has taken them.
  invoke("write", WriteSchema, VoidSchema, link),
  // Ends this side's direction. The far end's may go on.
  invoke("end", ChannelSchema, VoidSchema, link),
  // Tears the channel down, both directions.
  invoke("reset", ChannelSchema, VoidSchema, link),
);
