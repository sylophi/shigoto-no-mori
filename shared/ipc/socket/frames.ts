// Wire frames for the websocket host transport: the same contract
// modules the Electron bridge serves, carried over a LAN socket to a
// remote client. One JSON object per text frame.
//
// PROTOCOL INVARIANT: a field whose value is undefined is OMITTED from
// the frame. JSON.stringify already drops undefined object properties,
// and a reader sees the absent field as undefined again, so void
// inputs, outputs and broadcast payloads survive the wire unchanged:
// the registrar's decode of undefined behaves exactly as it does on the
// Electron wire.
//
// Frame size: the server caps INBOUND frames at 1 MiB (server.ts
// maxPayload, MAX_INBOUND_FRAME_BYTES below). That bound is about the
// hostile direction: client frames (hello, req) are tiny, so a small
// ceiling denies a pre-auth peer a large buffering budget. It does NOT
// limit outbound res/push frames (diffs, script logs), which the
// server writes and ws never measures against maxPayload. Bulk data
// (sync bundles, port-forward streams) still crosses in bounded
// chunks (WIRE_CHUNK_BYTES below) for flow control, and so an uplink
// req carrying a chunk stays under the inbound cap.
import { Effect, Schema } from "effect";
import { errorTagOf } from "../../errorOf.ts";
import {
  type AnyCodec,
  type CodecOut,
  parseWireJson,
  safeDecodeWith,
} from "../codec.ts";
import { WireErrorShapeSchema } from "../wireError.ts";
import { HANDSHAKE_NONCE_PATTERN } from "./proof";

// One well-known default keeps the app listener and a client's connect
// form aligned without either hardcoding it. High and unregistered so
// it stays clear of common dev servers.
export const DEFAULT_SOCKET_PORT = 42017;

// Largest inbound (client to server) frame the host will buffer, in
// bytes. Client frames are tiny by construction (the largest is a req
// carrying one WIRE_CHUNK_B64_MAX chunk), so 1 MiB is generous and
// still denies a pre-auth peer an unbounded buffering budget.
export const MAX_INBOUND_FRAME_BYTES = 1 << 20;

// One raw chunk of bulk app data per frame, for callers that move a
// bundle as base64 inside JSON invokes (the sync transfer, both
// directions). Chunking is what keeps an uplink req under
// MAX_INBOUND_FRAME_BYTES and what gives both directions flow control
// (each chunk is one awaited invoke round trip). The base64 form
// (853_336 chars) leaves headroom under the 1 MiB inbound cap for the
// frame fields around it. Byte STREAMS no longer ride this path: they
// are binary channel frames (channels.ts).
export const WIRE_CHUNK_BYTES = 640_000;
const WIRE_CHUNK_B64_MAX = Math.ceil(WIRE_CHUNK_BYTES / 3) * 4;

// The base64 form of one raw chunk, bounded by the cap above and
// pinned to the base64 charset so a non-base64 payload fails at the
// schema instead of silently decoding to garbage bytes. The ONE schema
// for every bulk-data field on both chunked wires (sync's bundleChunk result and pushChunk payload), so an uplink
// write can never exceed what a downlink chunk may carry and vice
// versa.
export const ChunkB64Schema = Schema.String.check(
  Schema.isMaxLength(WIRE_CHUNK_B64_MAX),
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
);

// Deadline for the first frame (a valid hello) after a socket opens.
// A shared two-sided protocol fact: slice B's client must send within
// it. Tests override via WsServerStartOpts.helloTimeoutMs.
export const HELLO_TIMEOUT_MS = 10_000;

// Liveness. A websocket over a NAT, a tunnel edge or a laptop that just
// slept can die without either end getting a close: the TCP flow is
// simply gone, and until the OS gives up (minutes, sometimes never)
// the socket reads as open, pushes fall into a void and nothing
// redials. So the CLIENT of every long-lived socket (a direct session,
// the hub socket) sends an app-level ping on HEARTBEAT_INTERVAL_MS and
// declares the socket dead when a ping stays unanswered for
// HEARTBEAT_TIMEOUT_MS, which hands the supervisor or keeper a close to
// redial on. Client driven because a browser page can neither send a
// protocol-level ping nor see one, so the app-level frame is the one
// mechanism every platform has. The timeout is measured from the
// oldest unanswered ping, never from "time since the last frame", so a
// background tab whose timers the browser throttles to one wake per
// minute is not misjudged dead by its own slow cadence. PROBE_TIMEOUT_MS
// is the short verdict window for a probe fired on a wake or a tab
// coming back, when waiting out a full interval would be the stale
// window the user notices.
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 40_000;
export const PROBE_TIMEOUT_MS = 5_000;

// The host side of the same rule: a peer that has proven it heartbeats
// (sent at least one ping) and then falls silent for this long is
// terminated, so a dead client socket does not sit in the authed set
// forever. Generous next to the client's timeout on purpose: a hidden
// browser tab pings once a minute under timer throttling and must not
// be killed for it. A peer that never pinged (an older build) is never
// judged, so a host can roll out ahead of its clients.
export const HOST_LIVENESS_TIMEOUT_MS = 120_000;

// Concurrent dispatched requests per connection, shared by the LAN
// binding (per socket) and the hub link (per peer). Over the cap a
// request is refused rather than spawning yet another git or CLI
// subprocess. 64: byte streams no longer park anything here (they are
// binary channel frames, channels.ts), but the headroom stays for a
// busy peer's ordinary invokes.
export const MAX_IN_FLIGHT_PER_PEER = 64;

// Skip a push once the outbound socket buffer passes this, shared by
// the LAN binding and the hub link, so a stalled peer or hub cannot
// grow main-process memory without bound via queued pushes. Pushes are
// recoverable refresh signals, so dropping one is safe.
export const PUSH_BUFFER_LIMIT_BYTES = 1 << 23;

// After a shutdown or owner close, how long a non-cooperating peer or a
// stalled device hub has before its socket is terminated, so it cannot
// wedge a lifecycle queue for ws's ~30s close window.
export const TERMINATE_GRACE_MS = 1_500;

// Application close codes (the 4000-4999 range websockets reserve for
// apps). AUTH_FAILED means the credential itself was wrong: the client
// must surface it and never auto-retry, or a typo'd token turns into a
// hammering loop. HELLO_FAILED covers a missing, late or malformed
// hello and is safe to retry.
//
// AUTH_LOCKED_OUT is the one the HOST must not conflate with
// AUTH_FAILED, and the reason it exists as its own code: the failed-auth
// lockout refuses a connection at CONNECT time, before any hello is
// read, purely because this client identity spent its attempts
// recently. It says nothing about the credential the refused client
// holds -- often nothing at all, since the lockout keys on IP and one
// device's typo benches every device behind the same NAT. It is
// TEMPORARY by construction (AUTH_LOCKOUT_MS, and a refused connection
// does not extend the window), so it is retryable and the client
// backs off through it. Only the host can tell the two apart, so the
// host says which one it is instead of leaving the client to guess
// from a predicate that cannot know.
export const CLOSE_AUTH_FAILED = 4001;
export const CLOSE_HELLO_FAILED = 4002;
export const CLOSE_AUTH_LOCKED_OUT = 4003;

// Standard websocket close codes the host uses on the shutdown and
// overload paths. GOING_AWAY is a normal retryable shutdown (stop or
// rotate). OVER_CAPACITY (try again later) rejects a connection when
// the listener is already at its connection cap, before any per-socket
// state is allocated.
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_OVER_CAPACITY = 1013;

// The first frame a client sends, required within the server's hello
// timeout (10s default). deviceId and appVersion identify the CLIENT,
// carried so the server can log or gate version skew later without a
// protocol change.
//
// The credential comes in one of two shapes, fixed by how the listener
// was constructed and never chosen by the frame: the legacy LAN wire
// reads `token`, the direct data plane reads `nonce` and `proof`
// (shared/ipc/socket/proof.ts). Both are optional so one schema serves
// both wires, and each listener fails closed without its own.
const HelloFrameSchema = Schema.Struct({
  t: Schema.Literal("hello"),
  token: Schema.optional(Schema.String),
  deviceId: Schema.String,
  appVersion: Schema.String,
  // The client's nonce, and its HMAC of both nonces under the ticket.
  nonce: Schema.optional(
    Schema.String.check(Schema.isPattern(HANDSHAKE_NONCE_PATTERN)),
  ),
  proof: Schema.optional(Schema.String),
  // The client can read deflated frames (deflatedFrame.ts), so the host
  // may send them. Absent from an old client, ignored by an old host.
  deflate: Schema.optional(Schema.Boolean),
});

export const ReqFrameSchema = Schema.Struct({
  t: Schema.Literal("req"),
  // Client-assigned correlation id, echoed on the matching res.
  id: Schema.Int,
  channel: Schema.String,
  // The contract input wire shape. Absent when the input is void.
  input: Schema.optional(Schema.Unknown),
});
export type ReqFrame = typeof ReqFrameSchema.Type;

// Sent by a client peer when it closes its side on purpose. The device hub carries no per-peer socket close, so without
// this a host would keep a hostSession for a departed peer until the
// next presence drop and fan every broadcast at it through the Durable
// Object. Additive per the version-skew policy: an old host fails to
// parse the frame and drops it, so the session then dies on presence
// exactly as before. The direct and LAN sockets have a real socket
// close, so they never need it and ignore it.
const ByeFrameSchema = Schema.Struct({
  t: Schema.Literal("bye"),
});

// The liveness pair (see HEARTBEAT_INTERVAL_MS): the client sends
// pings on its cadence and on a probe, the host only ever answers with
// pongs, so each frame lives in exactly one direction's union.
// Additive per the version-skew policy: an
// old peer fails to parse a ping and drops it. An old client against a
// new host is never judged (the host's sweep latches on the first
// ping), while a new client against an old host sees no pongs and
// redials it once a minute until that host updates, the soft
// degradation the owner's own rollout accepts elsewhere.
const PingFrameSchema = Schema.Struct({ t: Schema.Literal("ping") });
const PongFrameSchema = Schema.Struct({ t: Schema.Literal("pong") });

export const ClientFrameSchema = Schema.Union([
  HelloFrameSchema,
  ReqFrameSchema,
  ByeFrameSchema,
  PingFrameSchema,
]);
export type ClientFrame = typeof ClientFrameSchema.Type;

// Sent once in response to a valid hello. Here deviceId names the
// HOST's shigomori root (what a client keys its caches on) and
// appVersion is the host app's version.
const WelcomeFrameSchema = Schema.Struct({
  t: Schema.Literal("welcome"),
  deviceId: Schema.String,
  appVersion: Schema.String,
  // The host's half of the mutual proof, direct data plane only. A
  // proof-mode client refuses a welcome without it.
  proof: Schema.optional(Schema.String),
});

// Opens the direct data plane's handshake. Only the host's nonce, no
// secret, so it goes to an unauthenticated socket.
const ChallengeFrameSchema = Schema.Struct({
  t: Schema.Literal("challenge"),
  nonce: Schema.String.check(Schema.isPattern(HANDSHAKE_NONCE_PATTERN)),
});

const ResOkFrameSchema = Schema.Struct({
  t: Schema.Literal("res"),
  id: Schema.Int,
  ok: Schema.Literal(true),
  // The contract output wire shape. Absent when the output is void.
  result: Schema.optional(Schema.Unknown),
});

// The one refusal code either remote gate stamps on a res error today:
// the device hub's per-peer command-grant gate and the LAN wire's
// read-only gate. One shared constant so both
// client roles mint one typed error for "that machine will not run
// commands from here", distinct from a real handler failure.
export const COMMAND_REFUSED_CODE = "command-refused";

// The refusal message both gates carry. The exact text predates the
// code (the hub grant gate shipped it in step 4), so an OLD peer
// still sends it WITHOUT a code and message-based matching keeps
// working across version skew in both directions.
export const COMMAND_REFUSED_MESSAGE =
  "this device is not permitted to run commands on the remote machine";

export const COMMAND_REFUSED_TAG = "CommandRefused";

// The typed client-side surface of a command refusal, minted by both
// client roles (the LAN socket client transport and the hub link's
// client role) when a res error carries COMMAND_REFUSED_CODE. The
// message is preserved verbatim so every message-text matcher keeps
// behaving as before. Its tag is what the wire codec encodes
// (shared/ipc/wireError.ts), so the refusal crosses a hop (main
// forwarding a peer's answer to the renderer) as a WireError carrying
// this tag.
export class CommandRefusedError extends Schema.TaggedError<CommandRefusedError>()(
  COMMAND_REFUSED_TAG,
  { message: Schema.String },
) {}

// Matcher for every form a refusal arrives in: the instance a client
// role minted and the WireError a hop rebuilt, both by their tag, and
// the bare message an OLD peer sends with no code or tag at all. Each
// means "ask that machine to allow commands".
export function isCommandRefusedError(error: unknown): boolean {
  // The tag wins: a typed error of another kind is not a refusal
  // however its message reads. Only an untagged error is read by text.
  const tag = errorTagOf(error);
  if (tag !== undefined) return tag === COMMAND_REFUSED_TAG;
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
// `error` is the typed form (shared/ipc/wireError.ts): the handler's
// tag and fields, ADDITIVE the same way, so a matcher on the far side
// reads the tag and an old peer that sends none is read by message.
// A malformed `error` (a NEWER peer's shape this build cannot read)
// degrades to absent rather than failing the frame: a dropped res
// would leave the caller's invoke pending forever, since no wire has a
// per-call timeout, where a message-only answer rejects it at once.
// An absent `error` stays absent; a present one that does not decode
// becomes an own undefined, which every reader takes as absent (the
// output this frame has always decoded to, pinned by schema-port).
const ResErrFrameSchema = Schema.Struct({
  t: Schema.Literal("res"),
  id: Schema.Int,
  ok: Schema.Literal(false),
  message: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(WireErrorShapeSchema).pipe(
    Schema.catchDecoding(() => Effect.succeedSome(undefined)),
  ),
});

const PushFrameSchema = Schema.Struct({
  t: Schema.Literal("push"),
  channel: Schema.String,
  // The broadcast payload wire shape. Absent when the payload is void.
  payload: Schema.optional(Schema.Unknown),
});

// A union of literal-tagged structs, so the decode tries only the arms
// whose `t` matches: a push (the hot arm) never pays a failed welcome
// parse first. The two res forms share `t` and split on `ok`.
export const ServerFrameSchema = Schema.Union([
  WelcomeFrameSchema,
  ChallengeFrameSchema,
  ResOkFrameSchema,
  ResErrFrameSchema,
  PushFrameSchema,
  PongFrameSchema,
]);
export type ServerFrame = typeof ServerFrameSchema.Type;

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
export function decodeFrame<C extends AnyCodec>(
  text: string,
  schema: C,
): CodecOut<C> | null {
  let raw: unknown;
  try {
    raw = parseWireJson(text);
  } catch {
    return null;
  }
  const parsed = safeDecodeWith(schema, raw);
  return parsed.success ? parsed.data : null;
}
