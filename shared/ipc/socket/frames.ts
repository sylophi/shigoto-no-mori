// Wire frames for the websocket host transport: the same contract
// modules the Electron bridge serves, carried over a LAN socket to a
// remote client (v2 step 3, slice A). One JSON object per text frame.
//
// PROTOCOL INVARIANT: a field whose value is undefined is OMITTED from
// the frame. JSON.stringify already drops undefined object properties,
// and a reader sees the absent field as undefined again, so z.void()
// inputs, outputs and broadcast payloads survive the wire unchanged:
// the registrar's `def.input.parse(undefined)` behaves exactly as it
// does on the Electron wire.
//
// Frame size: the relay imposes MAX_RELAY_MESSAGE_BYTES per message
// (shared/relay/protocol.ts), so large res/push frames must chunk to
// ride that wire.
// The server caps INBOUND frames at 1 MiB (server.ts maxPayload). That
// bound is about the hostile direction: client frames (hello, req) are
// tiny, so a small ceiling denies a pre-auth peer a large buffering
// budget. It does NOT limit outbound res/push frames (diffs, script
// logs), which the server writes and ws never measures against
// maxPayload.
import { z } from "zod";

// One well-known default keeps the app listener and a client's connect
// form aligned without either hardcoding it. High and unregistered so
// it stays clear of common dev servers.
export const DEFAULT_SOCKET_PORT = 42017;

// Largest inbound (client to server) frame the host will buffer, in
// bytes. Client frames are tiny by construction, so 1 MiB is generous
// and still denies a pre-auth peer an unbounded buffering budget.
export const MAX_INBOUND_FRAME_BYTES = 1 << 20;

// Deadline for the first frame (a valid hello) after a socket opens.
// A shared two-sided protocol fact: slice B's client must send within
// it. Tests override via WsServerStartOpts.helloTimeoutMs.
export const HELLO_TIMEOUT_MS = 10_000;

// Concurrent dispatched requests per connection, shared by the LAN
// binding (per socket) and the relay link (per peer). Over the cap a
// request is refused rather than spawning yet another git or CLI
// subprocess. 64, raised from 32: each forwarded TCP connection parks a
// long-poll in this budget (host/ipc/modules/forward.ts), so 32 starved
// a peer's ordinary invokes once a forwarded browser tab and the forest
// UI were active together.
export const MAX_IN_FLIGHT_PER_PEER = 64;

// Skip a push once the outbound socket buffer passes this, shared by
// the LAN binding and the relay link, so a stalled peer or relay cannot
// grow main-process memory without bound via queued pushes. Pushes are
// recoverable refresh signals, so dropping one is safe.
export const PUSH_BUFFER_LIMIT_BYTES = 1 << 23;

// After a shutdown or owner close, how long a non-cooperating peer or a
// stalled relay has before its socket is terminated, so it cannot wedge
// a lifecycle queue for ws's ~30s close window.
export const TERMINATE_GRACE_MS = 1_500;

// Application close codes (the 4000-4999 range websockets reserve for
// apps). AUTH_FAILED means the token was wrong: the client must
// surface it and never auto-retry, or a typo'd token turns into a
// hammering loop. HELLO_FAILED covers a missing, late or malformed
// hello and is safe to retry.
export const CLOSE_AUTH_FAILED = 4001;
export const CLOSE_HELLO_FAILED = 4002;

// Standard websocket close codes the host uses on the shutdown and
// overload paths. GOING_AWAY is a normal retryable shutdown (stop or
// rotate). OVER_CAPACITY (try again later) rejects a connection when
// the listener is already at its connection cap, before any per-socket
// state is allocated.
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_OVER_CAPACITY = 1013;

// The first frame a client sends, required within the server's hello
// timeout (10s default). `token` is the shared secret from the device
// config -- step 4 replaces this auth wholesale with pairing, so
// nothing else should grow to depend on its shape. deviceId and
// appVersion identify the CLIENT, carried so the server can log or
// gate version skew later without a protocol change.
export const HelloFrameSchema = z.object({
  t: z.literal("hello"),
  token: z.string(),
  deviceId: z.string(),
  appVersion: z.string(),
});
export type HelloFrame = z.infer<typeof HelloFrameSchema>;

export const ReqFrameSchema = z.object({
  t: z.literal("req"),
  // Client-assigned correlation id, echoed on the matching res.
  id: z.number().int(),
  channel: z.string(),
  // The contract input wire shape. Absent when the input is void.
  input: z.unknown().optional(),
});
export type ReqFrame = z.infer<typeof ReqFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("t", [
  HelloFrameSchema,
  ReqFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// Sent once in response to a valid hello. Here deviceId names the
// HOST's shigomori root (what a client keys its caches on) and
// appVersion is the host app's version.
export const WelcomeFrameSchema = z.object({
  t: z.literal("welcome"),
  deviceId: z.string(),
  appVersion: z.string(),
});

export const ResOkFrameSchema = z.object({
  t: z.literal("res"),
  id: z.number().int(),
  ok: z.literal(true),
  // The contract output wire shape. Absent when the output is void.
  result: z.unknown().optional(),
});

// The one refusal code either remote gate stamps on a res error today:
// the relay's per-peer command-grant gate and the LAN wire's read-only
// gate (v2 step 6, slice B). One shared constant so both client roles
// mint one typed error for "that machine will not run commands from
// here", distinct from a real handler failure.
export const COMMAND_REFUSED_CODE = "command-refused";

// The refusal message both gates carry. The exact text predates the
// code (the relay grant gate shipped it in step 4), so an OLD peer
// still sends it WITHOUT a code and message-based matching keeps
// working across version skew in both directions.
export const COMMAND_REFUSED_MESSAGE =
  "this device is not permitted to run commands on the remote machine";

// The typed client-side surface of a command refusal, minted by both
// client roles (the LAN socket client transport and the relay link's
// client role) when a res error carries COMMAND_REFUSED_CODE. The
// message is preserved verbatim so every message-text matcher keeps
// behaving as before.
export class CommandRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRefusedError";
  }
}

// Matcher that survives Electron's IPC error serialization (which
// flattens an error to its message text): the renderer behind the relay
// bridge sees a plain Error carrying the refusal message, not the
// instance minted in main, and an OLD peer sends the message with no
// code at all. Either form means "ask that machine to allow commands".
export function isCommandRefusedError(error: unknown): boolean {
  if (error instanceof CommandRefusedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(COMMAND_REFUSED_MESSAGE);
}

// The err form carries a message string because that is exactly what
// survives Electron's IPC error serialization too: the matchers in
// shared/errors.ts key on message text, so both wires degrade handler
// failures identically. `code` is the machine-readable refusal
// classification, ADDITIVE per the version-skew policy: an old peer
// sends no code, and a reader treats absence as an unclassified
// failure, falling back to the message text.
export const ResErrFrameSchema = z.object({
  t: z.literal("res"),
  id: z.number().int(),
  ok: z.literal(false),
  message: z.string(),
  code: z.string().optional(),
});

export const PushFrameSchema = z.object({
  t: z.literal("push"),
  channel: z.string(),
  // The broadcast payload wire shape. Absent when the payload is void.
  payload: z.unknown().optional(),
});
export type PushFrame = z.infer<typeof PushFrameSchema>;

// Not a discriminated union: the two res forms share `t` and split on
// `ok`.
export const ServerFrameSchema = z.union([
  WelcomeFrameSchema,
  ResOkFrameSchema,
  ResErrFrameSchema,
  PushFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

// The one sanctioned serializer for both directions, so the
// omit-undefined invariant above has a single owner.
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame);
}

// The one sanctioned reader for both directions. A frame that is not
// valid JSON, or parses but fails its schema, is malformed and returns
// null. Callers treat a null as a dropped frame, never as fatal: one
// bad message must not tear down a socket carrying live traffic. Each
// side passes its own inbound schema (ServerFrameSchema on the client,
// ClientFrameSchema on the host).
export function decodeFrame<T>(text: string, schema: z.ZodType<T>): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
