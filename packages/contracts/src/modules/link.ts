import { CORE_VERSION } from "../protocol.ts";
import * as Schema from "effect/Schema";
import { defineContract, invoke, ungated } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { VoidSchema } from "../schemas/void.ts";
import { strict } from "../schemas/strict.ts";

// A link between devices is Colibrii's (@colibrii/sdk), which proves
// both ends and carries the greeting below before the link opens. The
// loopback's opens with link:hello and the host's token instead.

const AppVersionSchema = Schema.String.check(Schema.isMaxLength(64));

// What dials the loopback, which it keeps no record of.
const DeviceKindSchema = Schema.Literals(["desktop", "web"]);
export type DeviceKind = typeof DeviceKindSchema.Type;

const HelloSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    deviceKind: DeviceKindSchema,
    connectionId: HexId32Schema,
    appVersion: AppVersionSchema,
    // The core's (protocol.ts).
    protocolVersion: Schema.Int,
    token: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  }),
);

// Plain, so a later build's welcome can say more. The hello is what a
// build on another core reads before it refuses, and keeps its shape.
const WelcomeSchema = Schema.Struct({
  deviceId: DeviceIdSchema,
  appVersion: AppVersionSchema,
  // The version of each module the host serves on this link, by name
  // (../link.ts, versionsOf).
  versions: Schema.Record(Schema.String, Schema.Int),
});
export type Welcome = typeof WelcomeSchema.Type;

// A peer link's greeting, as Colibrii's app hello, welcome and refusal
// carry it. JSON, and plain, so a build on another core reads enough of
// it to refuse, or to show why it was refused.
export const PeerHelloSchema = Schema.Struct({
  appVersion: AppVersionSchema,
  coreVersion: Schema.Int,
});
export type PeerHello = typeof PeerHelloSchema.Type;

export const PeerWelcomeSchema = Schema.Struct({
  appVersion: AppVersionSchema,
  versions: Schema.Record(Schema.String, Schema.Int),
  // The host's switches as the link opens. Their pushes move them after.
  acceptsCommands: Schema.Boolean,
  sharesData: Schema.Boolean,
});
export type PeerWelcome = typeof PeerWelcomeSchema.Type;

// The refusal of a dialer on another core.
export const PeerRefusalSchema = Schema.Struct({
  hostVersion: Schema.Int,
  clientVersion: Schema.Int,
});

// Minted by the opener before the call that attaches the far end.
const ChannelSchema = strict(Schema.Struct({ channelId: HexId32Schema }));

// Small, so a channel's frames interleave finely with the link's other
// traffic: 32 KB is 13 ms on a 20 Mbit/s uplink.
export const CHANNEL_MAX_WRITE_BYTES = 32 * 1024;
export const CHANNEL_MAX_READ_BYTES = 32 * 1024;

// Calls are numbered per channel and direction, at most this many in
// flight (a 2 MiB window), answered in order. One further ahead is
// refused. A peer holds a bounded number per channel, so these hold no
// place in the link's gate (rpcTransport.ts).
export const CHANNEL_CALLS_IN_FLIGHT = 64;

// Plain, not strict: the binary layout carries only declared fields, and
// bytes have no JSON form a strict struct's could pass through.
const WriteSchema = Schema.Struct({
  channelId: HexId32Schema,
  seq: Schema.Natural,
  data: Schema.Uint8Array.check(
    Schema.makeFilter((bytes) => bytes.byteLength <= CHANNEL_MAX_WRITE_BYTES),
  ),
});

const ReadSchema = strict(
  Schema.Struct({
    channelId: HexId32Schema,
    seq: Schema.Natural,
  }),
);

// Never empty while the direction is open, empty once it ended. A reader
// asks only once it has room, so a slow reader holds the far end back.
const ReadBytesSchema = Schema.Uint8Array.check(
  Schema.makeFilter((bytes) => bytes.byteLength <= CHANNEL_MAX_READ_BYTES),
);

export const linkContract = defineContract(
  "link",
  { scope: "host", version: CORE_VERSION },
  invoke("hello", HelloSchema, WelcomeSchema, ungated),
  // For a link that may have died unseen.
  invoke("ping", VoidSchema, VoidSchema, ungated),
  invoke("read", ReadSchema, ReadBytesSchema, ungated),
  // Answers once the far end has taken them.
  invoke("write", WriteSchema, VoidSchema, ungated),
  invoke("end", ChannelSchema, VoidSchema, ungated),
  invoke("reset", ChannelSchema, VoidSchema, ungated),
);
