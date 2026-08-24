// Wire contract between the app and the relay Worker (v2 step 4,
// slice A): the HTTP route table, HTTP body schemas for the
// device/ticket endpoints, the relay socket envelopes, and the
// constants both sides must agree on. Imported by the app (a later
// slice) and by relay/, so the same rules as
// shared/ipc/socket/frames.ts apply: zod only, no node builtins, no
// electron.
//
// The relay never parses sm traffic. The `frame` field of a relay
// envelope is opaque to the Worker. It will carry the existing sm
// socket frames (frames.ts) once the app-side transport lands, but
// nothing here may depend on that shape.
//
// Ticket and credential string mechanics live in relay/src/ticket.ts.
// To the app both are opaque strings: the credential rides in the
// Authorization header and the ticket in the connect URL, unchanged.
import { z } from "zod";

// Largest relay envelope the DO will forward, in bytes of the
// serialized JSON. Cloudflare caps websocket messages at 1 MiB
// (1048576), so this sits under it to leave headroom for the envelope
// fields around the opaque frame. An oversize forward is answered with
// a `too-large` nack to the sender. Chunking big sm frames into
// smaller envelopes is the app-side transport's job in a later step,
// not the relay's.
export const MAX_RELAY_MESSAGE_BYTES = 1_000_000;

// Whether a serialized envelope fits under MAX_RELAY_MESSAGE_BYTES.
// The one owner of what counts against the limit: the DO measures the
// serialized DELIVER envelope (`{t:"relay",from,frame}` with the
// sender's deviceId as `from`), so the sender-side chunker (a later
// slice) must measure exactly that, not the bare frame. The fast
// paths avoid a full encode: a UTF-16 code unit becomes at least one
// and at most three UTF-8 bytes, so only the band in between needs a
// real count.
const utf8 = new TextEncoder();
export function relayTextWithinLimit(text: string): boolean {
  if (text.length > MAX_RELAY_MESSAGE_BYTES) return false;
  if (text.length * 3 <= MAX_RELAY_MESSAGE_BYTES) return true;
  return utf8.encode(text).byteLength <= MAX_RELAY_MESSAGE_BYTES;
}

// Application close codes for the relay socket. Deliberately disjoint
// from the LAN socket's 4001/4002 (frames.ts) so a log line's code
// names its transport. TICKET_REJECTED covers unknown, expired and
// replayed tickets alike: every case means "mint a fresh ticket and
// reconnect", and distinguishing them would only tell an attacker
// which guesses were close. DEVICE_REVOKED is terminal, the client
// must not retry without re-enrolling. SUPERSEDED means a newer socket
// for the same deviceId took over, the losing side must not fight it.
export const CLOSE_TICKET_REJECTED = 4101;
export const CLOSE_DEVICE_REVOKED = 4102;
export const CLOSE_SUPERSEDED = 4103;

// ---- HTTP routes ----

// The one route table both sides consume: the worker matches requests
// against it and the app builds requests from it, so method and path
// cannot drift apart. Auth is not a field here because it was
// decorative, nothing read it. The worker enforces the tier at each
// endpoint instead. The tiers are: a Clerk session token in the
// Authorization header for POST /devices/enroll, the long-lived device
// credential in the Authorization header for GET /devices,
// DELETE /devices/:id and POST /tickets, and the single-use connect
// ticket in the query string for GET /connect, because websocket
// clients cannot set headers.
export const RELAY_ROUTES = {
  enroll: { method: "POST", path: "/devices/enroll" },
  listDevices: { method: "GET", path: "/devices" },
  revokeDevice: {
    method: "DELETE",
    path: (deviceId: string) => `/devices/${encodeURIComponent(deviceId)}`,
  },
  mintTicket: { method: "POST", path: "/tickets" },
  connect: { method: "GET", path: "/connect" },
} as const;

// The query parameter GET /connect reads the ticket from.
export const CONNECT_TICKET_PARAM = "ticket";

// ---- HTTP bodies ----

// Every error response is `{ error }` with a meaningful status code.
export const ErrorBodySchema = z.object({ error: z.string() });
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// POST /devices/enroll request, under a Clerk session token. deviceId
// is the app's per-root UUID, so re-enrolling the same root rotates
// the credential instead of growing the device list. The bounds are
// load-bearing, not cosmetic. deviceId becomes a Durable Object
// websocket accept tag, which workerd hard-caps at 256 characters and
// throws past it, so it stays well under that. name and platform are
// bounded so an enroll cannot store unbounded strings under a Clerk
// token.
export const EnrollRequestSchema = z.object({
  deviceId: z.string().min(1).max(200),
  name: z.string().min(1).max(256),
  platform: z.string().min(1).max(64),
});

// One device as the HTTP API reports it. Timestamps are epoch
// milliseconds. lastSeenAt is null until the device first connects.
export const DeviceInfoSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  platform: z.string(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
  online: z.boolean(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

// POST /devices/enroll response. `credential` is the only time the
// raw credential ever leaves the Worker.
export const EnrollResponseSchema = z.object({
  credential: z.string(),
  device: DeviceInfoSchema,
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

// GET /devices response, scoped to the calling credential's account.
export const DeviceListResponseSchema = z.object({
  devices: z.array(DeviceInfoSchema),
});
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;

// POST /tickets response. The ticket string is opaque to clients: the
// app puts it in the connect URL unchanged, only the worker mints and
// parses it (relay/src/ticket.ts). expiresInMs is relative so the
// client does not need a synchronized clock.
export const TicketResponseSchema = z.object({
  ticket: z.string(),
  expiresInMs: z.number().int(),
});
export type TicketResponse = z.infer<typeof TicketResponseSchema>;

// ---- Relay socket envelopes ----

// Device to DO: ask the relay to forward the opaque frame to another
// device of the same account. There is no hello on this socket, the
// consumed ticket already binds the connection to a deviceId. `to` is
// bounded to match a deviceId, since it is fed straight to
// getWebSockets on the relay hot path.
export const RelaySendEnvelopeSchema = z.object({
  t: z.literal("relay"),
  to: z.string().min(1).max(200),
  frame: z.unknown(),
});

// The union of everything a device may send. A one-armed union today,
// kept as a union so later client envelopes are an addition, not a
// reshape.
export const DeviceEnvelopeSchema = z.discriminatedUnion("t", [
  RelaySendEnvelopeSchema,
]);
export type DeviceEnvelope = z.infer<typeof DeviceEnvelopeSchema>;

// DO to device: a frame forwarded from another device. The relay
// copies `frame` verbatim, it never parses or rewrites it.
export const RelayDeliverEnvelopeSchema = z.object({
  t: z.literal("relay"),
  from: z.string(),
  frame: z.unknown(),
});

// DO to device: the full list of the account's online deviceIds
// (including the receiver). Sent to a socket right after it is
// accepted and rebroadcast to everyone on every join and leave, so a
// client only ever replaces its copy, never merges deltas.
export const PresenceEnvelopeSchema = z.object({
  t: z.literal("presence"),
  online: z.array(z.string()),
});

// DO to device: a send could not be delivered. `offline` means no
// socket is connected for `to`. `too-large` means the serialized
// forward exceeded MAX_RELAY_MESSAGE_BYTES.
export const NackEnvelopeSchema = z.object({
  t: z.literal("nack"),
  to: z.string(),
  reason: z.enum(["offline", "too-large"]),
});

export const ServerEnvelopeSchema = z.discriminatedUnion("t", [
  RelayDeliverEnvelopeSchema,
  PresenceEnvelopeSchema,
  NackEnvelopeSchema,
]);
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>;

// The one sanctioned serializer, mirroring frames.ts: undefined
// fields are omitted and come back as undefined, so an opaque frame
// value survives the relay hop unchanged.
export function encodeEnvelope(
  envelope: DeviceEnvelope | ServerEnvelope,
): string {
  return JSON.stringify(envelope);
}

// The one sanctioned reader is literally the LAN socket's: invalid
// JSON or a schema miss returns null, and callers treat that as a
// dropped message, never as fatal. Re-exported under the envelope
// name so relay callers stay in this file's vocabulary.
export { decodeFrame as decodeEnvelope } from "../ipc/socket/frames.ts";
