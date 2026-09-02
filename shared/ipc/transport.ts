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
  // Whether the CALLING peer currently holds command access on the
  // process serving this call, supplied by the transport binding so a
  // handler can answer the preflight "am I granted?" read per caller
  // without ever seeing the grant list. The Electron binding says yes
  // (a local window commands its own machine), the LAN socket says no
  // (that wire is read-only by policy), and the direct data-plane
  // listener reads the host's live per-peer grant for the calling
  // deviceId. Optional and FAIL-CLOSED: a transport that supplies no
  // verdict reads as not granted.
  isCallerCommandGranted?: () => boolean;
  // The AUTHENTICATED deviceId of the calling peer, supplied only by a
  // wire that verified one: the direct data-plane listener (the connect
  // ticket bound the hello to a deviceId). The Electron wire, the
  // legacy LAN socket and in-page loopbacks leave it undefined, so a
  // handler that needs a peer identity (direct:connectInfo minting a
  // ticket for its caller) fails closed on absence. The device hub's
  // broker slot carries its own minimal context (shared/hub/link.ts)
  // and never mints a HandlerContext at all.
  callerDeviceId?: string;
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
// call's `def.mutating` here so a remote binding can gate commands. The
// direct data-plane listener gates them on a per-peer command grant.
// The LAN binding has no grant model, so it serves ONLY channels
// explicitly registered mutating:false and refuses everything else
// (fail-closed read-only). The Electron binding ignores it: a local
// window commands its own machine.
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
