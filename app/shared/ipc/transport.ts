import type { ContractModule } from "@shigomori/contracts/contract";
import type { CallFailure } from "@shigomori/contracts/errors";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import type { LinkChannels } from "@shigomori/contracts/link";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  ViewObserver,
} from "@shigomori/contracts/types";

// The client's one seam onto the wire. A transport carries invokes and
// broadcast subscriptions for a single connection to a serving process.
// Effect RPC binds it on every wire (shared/remote/rpcTransport.ts), the
// window's port to its shell and the device link alike, and nothing
// above this type knows which.
export type ClientTransport = {
  invoke(
    channel: string,
    input: unknown,
    options?: InvokeOptions,
  ): Promise<unknown>;
  subscribe(channel: string, handler: (payload: unknown) => void): () => void;
  // A view (contract.ts): its values as they come, until the returned
  // stop, or `end` when the far side ends it, fails, or the link drops.
  // Only a wire that carries views has it.
  watch?(
    channel: string,
    input: unknown,
    observer: ViewObserver<unknown>,
  ): () => void;
  // True when the far end is this machine's own serving side, the same
  // build: the client hands its results through as they are. Any other
  // transport may reach a peer on another build, so the client decodes
  // every result and push with the call's schema (buildClient.ts), the
  // check the serving side makes of its inputs.
  readonly local?: boolean;
};

// The same connection as Effects and Streams, which a client runtime
// runs its calls, views and pushes on (renderer/lib/runtime). A call
// fails with what its Promise face rejects with: the contract error it
// was sent as, or the link gone. Interrupting it cancels the call on
// the far side. `linkTransport` (shared/remote/rpcTransport.ts) is the
// Promise face over it.
export type Link = {
  readonly local?: boolean;
  readonly call: (
    channel: string,
    input: unknown,
    span?: Tracer.AnySpan,
  ) => Effect.Effect<unknown, unknown>;
  readonly view: (
    channel: string,
    input: unknown,
  ) => Stream.Stream<unknown, unknown>;
  readonly pushes: (channel: string) => Stream.Stream<unknown>;
};

// What a caller may hand an invoke on the device link: `signal`
// cancels it, interrupting the host's handler, and `span` is the span
// the call continues, so the peer's work joins the caller's trace.
export type InvokeOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly span?: Tracer.AnySpan | undefined;
};

// Context handed to every invoke handler. Deliberately Electron free:
// minting a notifier bound to the calling connection lets a handler
// stream broadcasts back to whoever invoked it, and the signal tells a
// long-running handler that the caller is gone. Delivery semantics
// (drop once the peer is gone) live in the server transport binding.
export type HandlerContext = {
  notifier<M extends ContractModule, K extends BroadcastKeys<M>>(
    module: M,
    key: K,
  ): (payload: BroadcastProducerPayload<M, K>) => void;
  // Aborts when the call is cancelled: the caller interrupting it, or
  // its link dropping (a window's page going, reload included).
  // Consumers that attach listeners should remove them when the call
  // completes.
  signal: AbortSignal;
  // Aborts when the caller's link is gone. One per connection, so a
  // stream a caller joins can tell a connection that already hears it
  // from a new one.
  connection: AbortSignal;
  // The AUTHENTICATED deviceId of the calling peer, supplied only by a
  // wire that verified one: the device link (the connect ticket bound
  // the hello to a deviceId). The shell's port and the loopback, where
  // every caller is this machine's own, leave it undefined, so a
  // handler that needs a peer identity fails closed on absence.
  callerDeviceId?: string;
  // Byte channels on the calling link (shared/remote/channels.ts),
  // supplied only by the device link: a handler
  // that opens a byte stream for its caller (forward:open) attaches
  // the far end here under the client-minted channel id. Absent on
  // wires without a binary lane (the shell's port), where such a
  // handler refuses.
  channels?: LinkChannels;
};

// Whether the calling peer is another device rather than this
// machine's own window. Only a wire that authenticated a peer stamps
// callerDeviceId (the device link off the loopback) and no local wire
// does, so the stamp is exactly "another device asked". One
// definition next to the field it interprets, for every handler or
// binding that branches on it.
export function isRemoteCaller(
  ctx: Pick<HandlerContext, "callerDeviceId">,
): boolean {
  return ctx.callerDeviceId !== undefined;
}

// A server transport owns the wire. `handle` mounts one channel and
// supplies each call with a context bound to the calling peer.
// `broadcastAll` ships one payload to every connected peer. Both
// directions take wire shapes: parsing happens in registerContract.ts
// before anything reaches a transport.
//
// `opts.remote` is the exposure axis: the registrar passes each call's
// Remote annotation here so a composite transport can decide whether the
// channel reaches a remote (websocket) peer at all. Scope answers "runs
// where the files live"; remote answers "safe to serve a remote peer",
// and the two are independent decisions. Single-wire transports ignore
// it (they already know their reach).
//
// `opts.gated` is the command-vs-read axis: the registrar passes each
// call's Gated annotation here so a remote binding can gate commands. The
// direct data-plane listener serves channels explicitly registered
// gated:false to every peer and gates everything else on the host's
// command-access switch (fail-closed). The Electron binding ignores
// it: a local window commands its own machine.
type TransportCallOpts = { remote?: boolean; gated?: boolean };

export type ServerTransport = {
  handle(
    channel: string,
    fn: (ctx: HandlerContext, raw: unknown) => Promise<unknown>,
    opts?: TransportCallOpts,
  ): void;
  broadcastAll(
    channel: string,
    payload: unknown,
    opts?: TransportCallOpts,
  ): void;
};

// What a server built in a layer graph hands each call: the context
// without the signal, since such a call is an effect, cancelled by
// interruption. The registrar gives a Promise handler a signal of its
// own that aborts with it (registerContract.ts, registerHostContract).
export type CallContext = Omit<HandlerContext, "signal">;

// The server side of a layer graph's wires: each call mounted as an
// effect on the graph's `Services`.
export type EffectServerTransport<Services> = {
  handle(
    channel: string,
    fn: (
      ctx: CallContext,
      raw: unknown,
    ) => Effect.Effect<unknown, CallFailure, Services>,
    opts?: TransportCallOpts,
  ): void;
  broadcastAll: ServerTransport["broadcastAll"];
};
