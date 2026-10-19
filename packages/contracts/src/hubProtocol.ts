// Runs in the Worker too: Effect Schema only, no node builtins.
//
// The hub never reads what devices say to each other: a relay frame is
// sealed as a Noise handshake message to its addressee, and contract data
// rides only the direct sockets the hub brokers. Every peer the hub
// delivers to is a device of the same account (a ticket is burned against
// it), and a peer proves its enrolled key in the handshake. The bounds in
// this file keep a bug or a hostile party from ballooning allocations.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  DEVICE_ICONS,
  fallbackDeviceIcon,
  isDeviceIcon,
} from "./deviceIcon.ts";
import { PortNumberSchema } from "./schemas/ports.ts";

// A control-frame budget, in bytes of serialized JSON. The worst-case
// presence roster must fit (hub.spec.ts asserts it).
export const MAX_HUB_MESSAGE_BYTES = 64 * 1024;

// A UTF-16 unit is one to three UTF-8 bytes, so only the band between
// needs a real count. `extraBytes` is what the text grows by on its way
// (deliveredRelayGrowth).
const utf8 = new TextEncoder();
export function hubTextWithinLimit(text: string, extraBytes = 0): boolean {
  const budget = MAX_HUB_MESSAGE_BYTES - extraBytes;
  if (text.length > budget) return false;
  if (text.length * 3 <= budget) return true;
  return utf8.encode(text).byteLength <= budget;
}

export function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

// The client's cap on a presence roster (the DO runs no admission gate
// against it), bounding what a hostile DO can make it allocate.
export const MAX_ONLINE_DEVICES = 64;

// Sign-up is public and each device can provision a tunnel and DNS
// record on the shared Cloudflare account. A browser profile counts.
export const MAX_ACCOUNT_DEVICES = 16;

// Disjoint from the device link's codes, so a log line's code names its
// transport. TICKET_REJECTED covers unknown, expired and replayed alike,
// so an attacker can't tell which guesses were close. DEVICE_REVOKED is
// terminal. SUPERSEDED: a newer socket took over; don't fight it.
export const CLOSE_TICKET_REJECTED = 4101;
export const CLOSE_DEVICE_REVOKED = 4102;
export const CLOSE_SUPERSEDED = 4103;
export const CLOSE_CREDENTIAL_ROTATED = 4104;
export const CLOSE_RATE_LIMITED = 4105;
// The socket stopped answering its pings (a laptop asleep with it left
// open), so the hub took it off the roster. Not a verdict: the device
// dials again once it is back.
export const CLOSE_SILENT = 4106;

// A browser profile holds one per tab. Past it, the oldest gives way.
export const MAX_DEVICE_CONNECTIONS = 32;

// Under workerd's 256-char cap on a websocket accept tag, which throws
// past it.
export const DeviceIdSchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(200),
);

// X25519, 32 bytes as unpadded base64url.
const DevicePublicKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/),
);

// Bare text, answered by the hibernation runtime's auto-response (an
// exact-string match), so a ping never wakes the object.
export const HUB_PING = "ping";
export const HUB_PONG = "pong";

// ---- HTTP bodies (hubApi.ts) ----

// Any short string: the catalog check happens on read.
const DeviceIconWireSchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(64),
);

const DeviceNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(256));

export const EnrollRequestSchema = Schema.Struct({
  deviceId: DeviceIdSchema,
  name: DeviceNameSchema,
  platform: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  // Not checked against the catalog: a client whose catalog grew ahead
  // of the Worker must still sign in.
  icon: DeviceIconWireSchema,
  publicKey: DevicePublicKeySchema,
});

export const DevicePatchRequestSchema = Schema.Struct({
  name: Schema.optional(DeviceNameSchema),
  icon: Schema.optional(DeviceIconWireSchema),
}).check(
  Schema.makeFilter(
    (patch) =>
      patch.name !== undefined ||
      patch.icon !== undefined ||
      "nothing to change",
  ),
);
export type DevicePatch = typeof DevicePatchRequestSchema.Type;

// An icon this build's catalog lacks reads as its platform's.
const DeviceInfoWireSchema = Schema.Struct({
  deviceId: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  icon: Schema.String,
  createdAt: Schema.Int,
  lastSeenAt: Schema.NullOr(Schema.Int),
  online: Schema.Boolean,
});
export const DeviceInfoSchema = DeviceInfoWireSchema.pipe(
  Schema.decodeTo(
    Schema.Struct({
      ...DeviceInfoWireSchema.fields,
      icon: Schema.Literals(DEVICE_ICONS),
    }),
    SchemaTransformation.transform({
      decode: (info) => ({
        ...info,
        icon: isDeviceIcon(info.icon)
          ? info.icon
          : fallbackDeviceIcon(info.platform),
      }),
      encode: (info) => info,
    }),
  ),
);
export type DeviceInfo = typeof DeviceInfoSchema.Type;
export type DeviceInfoWire = typeof DeviceInfoSchema.Encoded;

// The only time the raw credential leaves the Worker.
export const EnrollResponseSchema = Schema.Struct({
  credential: Schema.String,
  device: DeviceInfoSchema,
});
export type EnrollResponse = typeof EnrollResponseSchema.Type;

export const DeviceListResponseSchema = Schema.Struct({
  devices: Schema.Array(DeviceInfoSchema),
});

export const TicketResponseSchema = Schema.Struct({
  ticket: Schema.String,
});
export type TicketResponse = typeof TicketResponseSchema.Type;

export const TunnelProvisionRequestSchema = Schema.Struct({
  port: PortNumberSchema,
});

// `connectorToken` is a bearer secret: memory and the child's env only,
// never argv, logs or the renderer.
export const TunnelProvisionResponseSchema = Schema.Struct({
  hostname: Schema.NonEmptyString,
  connectorToken: Schema.NonEmptyString,
  // A new DNS record can take a while to resolve.
  dnsCreated: Schema.optional(Schema.Boolean),
});
export type TunnelProvisionResponse = typeof TunnelProvisionResponseSchema.Type;

// ---- Hub socket envelopes ----

// No hello: the burned ticket already binds the socket to a device.
const HubSendEnvelopeSchema = Schema.Struct({
  t: Schema.Literal("relay"),
  to: DeviceIdSchema,
  frame: Schema.String,
});

export const DeviceEnvelopeSchema = Schema.Union([HubSendEnvelopeSchema]);
export type DeviceEnvelope = typeof DeviceEnvelopeSchema.Type;

const HubDeliverEnvelopeSchema = Schema.Struct({
  t: Schema.Literal("relay"),
  from: DeviceIdSchema,
  frame: Schema.String,
});

// The relay the hub delivers for one it was sent: the same frame, the
// sender's id in place of the target's. The hub measures this against
// MAX_HUB_MESSAGE_BYTES, and a sender predicts it from its own envelope
// by deliveredRelayGrowth, so the two cannot disagree on the shape.
export const deliveredRelay = (from: string, frame: string): string =>
  encodeEnvelope({ t: "relay", from, frame });

// How many bytes the delivered relay is longer than the one sent, each
// id as JSON writes it.
export const deliveredRelayGrowth = (from: string, to: string): number =>
  utf8ByteLength(`"from":${JSON.stringify(from)}`) -
  utf8ByteLength(`"to":${JSON.stringify(to)}`);

const OnlineDeviceSchema = Schema.Struct({
  deviceId: DeviceIdSchema,
  publicKey: DevicePublicKeySchema,
});
export type OnlineDevice = typeof OnlineDeviceSchema.Type;

// The whole roster, the receiver included, on every change: a client
// replaces its copy, never merges.
const PresenceEnvelopeSchema = Schema.Struct({
  t: Schema.Literal("presence"),
  online: Schema.Array(OnlineDeviceSchema).check(
    Schema.isMaxLength(MAX_ONLINE_DEVICES),
  ),
});

const NackEnvelopeSchema = Schema.Struct({
  t: Schema.Literal("nack"),
  to: DeviceIdSchema,
  reason: Schema.Literals(["offline", "too-large"]),
});

export const ServerEnvelopeSchema = Schema.Union([
  HubDeliverEnvelopeSchema,
  PresenceEnvelopeSchema,
  NackEnvelopeSchema,
]);
export type ServerEnvelope = typeof ServerEnvelopeSchema.Type;

export function encodeEnvelope(
  envelope: DeviceEnvelope | ServerEnvelope,
): string {
  return JSON.stringify(envelope);
}

// Null for anything that doesn't read: a dropped message, never fatal.
export function decodeEnvelope<S extends Schema.Decoder<unknown>>(
  text: string,
  schema: S,
): S["Type"] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return Option.getOrNull(Schema.decodeUnknownOption(schema)(raw));
}

// ---- The connectInfo ask and answer ----

// `sealed` is a Noise IK handshake message (unpadded base64url): the ask
// the first, sealed to the addressee's key, the answer the second.
export type RelayFrame = {
  readonly kind: "ask" | "answer";
  readonly id: number;
  readonly sealed: string;
};

const RELAY_FRAME = /^(ask|answer):(\d{1,16}):([A-Za-z0-9_-]+)$/;

export function encodeRelayFrame(frame: RelayFrame): string {
  return `${frame.kind}:${frame.id}:${frame.sealed}`;
}

export function decodeRelayFrame(text: string): RelayFrame | null {
  const match = RELAY_FRAME.exec(text);
  if (match === null) return null;
  return {
    kind: match[1] === "ask" ? "ask" : "answer",
    id: Number(match[2]),
    sealed: match[3] ?? "",
  };
}

// What the sealed messages carry. An IK first message can be replayed,
// so the answering device turns away one it has read before.
const AskNameSchema = Schema.String.check(Schema.isMaxLength(64));

export const AskPayloadSchema = Schema.Struct({
  ask: AskNameSchema,
  input: Schema.optional(Schema.Unknown),
});
export type AskPayload = typeof AskPayloadSchema.Type;

export const AnswerPayloadSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
    code: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  }),
]);
export type AnswerPayload = typeof AnswerPayloadSchema.Type;
