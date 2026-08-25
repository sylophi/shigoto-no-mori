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
  // Aborts when the calling peer is gone. The granularity follows the
  // wire: on the Electron transport that is the page generation, so a
  // cross-document navigation (reload included) or window close; on
  // the websocket transport it is the connection, aborting when the
  // socket closes. It is shared by every call from the same peer, not
  // a per-call cancellation. Consumers that attach listeners should
  // remove them when the call completes.
  signal: AbortSignal;
};

// A server transport owns the wire. `handle` mounts one channel and
// supplies each call with a context bound to the calling peer.
// `broadcastAll` ships one payload to every connected peer. Both
// directions take wire shapes: parsing happens in registerContract.ts
// before anything reaches a transport.
//
// `opts.remote` is the exposure axis: the registrar passes each call's
// `def.remote` here so a composite transport can decide whether the
// channel reaches a remote (websocket) peer at all. Scope answers "runs
// where the files live"; remote answers "safe to serve a remote peer",
// and the two are independent decisions. Single-wire transports ignore
// it (they already know their reach).
//
// `opts.mutating` is the command-vs-read axis: the registrar passes each
// call's `def.mutating` here so the relay binding can collect the
// mutating channel names and gate them on a per-peer command grant.
// Bindings with no grant model (the Electron binding, the LAN socket)
// ignore it.
export type TransportCallOpts = { remote?: boolean; mutating?: boolean };

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
