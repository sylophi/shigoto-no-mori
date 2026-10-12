import type { ContractModule } from "@shigomori/contracts/contract";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import type { LinkChannels } from "@shigomori/contracts/link";
import type {
  PushKeys,
  PushProducerPayload,
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
  // build.
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
// stream broadcasts back to whoever invoked it. A caller that is gone
// interrupts its call. Delivery semantics (drop once the peer is gone)
// live in the server transport binding.
export type HandlerContext = {
  notifier<M extends ContractModule, K extends PushKeys<M>>(
    module: M,
    key: K,
  ): (payload: PushProducerPayload<M, K>) => void;
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
  // The window the call came from (its webContents id), supplied only
  // by the shell's port, which each window holds one of: what a call
  // about "this window" (its route, its deep link) answers for.
  windowId?: number;
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
