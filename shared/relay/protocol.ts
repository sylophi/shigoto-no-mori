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
// TRUST MODEL: the relay is our own managed service, not an adversary.
// Enrollment requires a Clerk-verified login, each device holds a
// long-lived credential it exchanges for short-lived single-use connect
// tickets, and the DO authenticates the account when it burns the
// ticket, so every deliverable peer is by construction a device of the
// same account. That is why the app-level hello token is ignored on the
// relay path. Authorization stays host-local: mutating calls are gated
// on per-peer command grants and dispatch fails closed (see
// shared/relay/link.ts). The size and count bounds in this file are
// sanity bounds that keep a bug or a runaway client from ballooning
// allocations, and the session epoch on the sm frames defends against
// cross-session mismatch after a redial, not against the relay itself.
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
export function relayTextWithinLimit(text: string, extraBytes = 0): boolean {
  // extraBytes lets the sender measure a shape it does not literally
  // encode. The DO measures the DELIVER envelope (from = our id) while
  // the sender only encodes the SEND envelope (to = the target), and the
  // two differ by a fixed routing-field delta, so one encode plus the
  // delta serves both without a second full stringify on the hot path.
  const budget = MAX_RELAY_MESSAGE_BYTES - extraBytes;
  if (text.length > budget) return false;
  if (text.length * 3 <= budget) return true;
  return utf8.encode(text).byteLength <= budget;
}

// Byte length of a string under UTF-8, for the small routing-field delta
// the relay link measures with. Not on the large-payload hot path, so a
// direct encode is fine here.
export function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

// One raw chunk of bulk app data per relay message, for callers that
// move byte streams as base64 inside a JSON frame inside the relay
// envelope (the port-forward wire and its slice B client engine). The
// base64 form is ceil(640_000/3)*4 = 853_336 chars, leaving ~146 KB of
// headroom under MAX_RELAY_MESSAGE_BYTES for the frame and envelope
// fields around it. The two values must move together.
export const RELAY_CHUNK_BYTES = 640_000;
export const RELAY_CHUNK_B64_MAX = 853_336;

// The most online devices a presence roster may name. An account's
// device count is small in practice, so this sits far above any real
// roster while still bounding what a hostile DO can force a client to
// allocate from one presence envelope.
export const MAX_ONLINE_DEVICES = 1024;

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

// A relay device id, the enrollment UUID, bounded to the DO accept-tag
// limit (workerd hard-caps a websocket accept tag at 256 chars, so this
// stays well under it). The single source for the several wire and IPC
// sites that route or grant against a device id.
export const DeviceIdSchema = z.string().min(1).max(200);

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
  to: DeviceIdSchema,
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
  // Bounded like RelaySendEnvelopeSchema.to: a hostile DO can forge this,
  // and it is fed straight into per-peer routing and log lines, so it is
  // never left unbounded.
  from: z.string().min(1).max(200),
  frame: z.unknown(),
});

// DO to device: the full list of the account's online deviceIds
// (including the receiver). Sent to a socket right after it is
// accepted and rebroadcast to everyone on every join and leave, so a
// client only ever replaces its copy, never merges deltas.
export const PresenceEnvelopeSchema = z.object({
  t: z.literal("presence"),
  // Each entry is a deviceId, bounded like RelaySendEnvelopeSchema.to,
  // and the roster length is capped so a hostile DO cannot force an
  // unbounded allocation from one presence envelope. The DO always names
  // real account devices, so both bounds are additive tightenings it
  // already satisfies.
  online: z.array(z.string().min(1).max(200)).max(MAX_ONLINE_DEVICES),
});

// DO to device: a send could not be delivered. `offline` means no
// socket is connected for `to`. `too-large` means the serialized
// forward exceeded MAX_RELAY_MESSAGE_BYTES.
export const NackEnvelopeSchema = z.object({
  t: z.literal("nack"),
  // Echoes the `to` the sender used, already bounded on send, so the
  // same bound applies coming back.
  to: z.string().min(1).max(200),
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
