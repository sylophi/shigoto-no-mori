import type { ContractModule } from "./contract";
import type { BroadcastKeys, BroadcastProducerPayload } from "./types";

// The client's one seam onto the wire. A transport carries invokes and
// broadcast subscriptions for a single connection to a serving process.
// The Electron binding wraps the renderer IPC bridge in the preload, a
// remote binding would wrap a socket, and nothing above this type knows
// which.
export type ClientTransport = {
  invoke(channel: string, input: unknown): Promise<unknown>;
  subscribe(channel: string, handler: (payload: unknown) => void): () => void;
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
  // Aborts when the calling page goes away, meaning a cross-document
  // navigation (reload included) or window close. It is shared by every
  // call from the same page, not a per-call cancellation. Consumers
  // that attach listeners should remove them when the call completes.
  signal: AbortSignal;
};

// A server transport owns the wire. `handle` mounts one channel and
// supplies each call with a context bound to the calling peer.
// `broadcastAll` ships one payload to every connected peer. Both
// directions take wire shapes: parsing happens in registerContract.ts
// before anything reaches a transport.
export type ServerTransport = {
  handle(
    channel: string,
    fn: (ctx: HandlerContext, raw: unknown) => Promise<unknown>,
  ): void;
  broadcastAll(channel: string, payload: unknown): void;
};
