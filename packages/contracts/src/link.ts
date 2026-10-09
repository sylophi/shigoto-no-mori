// The device link's RPC group: every call a peer may make over one
// socket, the pushes as streams, and the byte channels (modules/link.ts).
// Built here, once, so the host that serves it and every client that
// dials it (the desktop, the web client, the terminal `sm`) compile the
// same group and decode the same errors.
//
// The link's own calls open every connection: the handshake, which no
// middleware guards, then the rest, which PeerAuth guards (a call before
// an accepted hello is refused) and CommandGate classifies (a gated call
// runs only under the host's command switch, or as a call the host
// invited).
import * as Context from "effect/Context";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { allContractModules } from "./allModules.ts";
import {
  annotation,
  callsOf,
  channelOf,
  type ContractModule,
  isBroadcast,
  Remote,
  scopeOf,
} from "./contract.ts";
import {
  CommandRefusedError,
  LinkUnauthenticatedError,
  RemoteCallError,
} from "./errors.ts";
import { controlContract } from "./modules/control.ts";
import { linkContract } from "./modules/link.ts";
import type { BroadcastKeys, BroadcastProducerPayload } from "./types.ts";

// One end of a byte channel, as the side that attached it sees it.
export type ChannelEndpoint = {
  // Bytes from the far end. Call `consumed` once the sink has taken
  // them (a stream's write callback): that is what lets the far end
  // send more, so calling it early defeats backpressure.
  onData(data: Uint8Array, consumed: () => void): void;
  // The far end ended its direction. Nothing more arrives. This side
  // may still write until it ends too.
  onEnd(): void;
  // The far end reset the channel, or the link died. Both directions
  // are over and the channel is gone.
  onReset(): void;
  // Both directions ended cleanly and the channel is gone.
  onComplete?(): void;
  // Everything written has gone out, so a paused source may resume.
  onWritable(): void;
};

// A channel as its side writes to it.
export type ChannelHandle = {
  readonly channelId: string;
  // Queues the bytes. False once more is queued than the window: pause
  // the source until onWritable.
  write(data: Uint8Array): boolean;
  // Ends this direction once the queue drains.
  end(): void;
  // Tears the channel down now, both directions, dropping any queue.
  // A no-op once the channel is gone.
  reset(): void;
  // Whether the channel is still there (neither reset nor fully ended).
  readonly open: boolean;
};

// The link's byte channels as the host attaches them.
export type LinkChannels = {
  // `invited` marks a channel a call the host invited attached: the
  // command switch turning off leaves it be (CommandGate).
  attach(
    channelId: string,
    endpoint: ChannelEndpoint,
    opts?: { readonly invited?: boolean },
  ): ChannelHandle;
  has(channelId: string): boolean;
  size(): number;
};

// The peer on the other end of a link, once its hello was accepted:
// what a handler serving it reads, provided by PeerAuth.
export class LinkPeer extends Context.Service<
  LinkPeer,
  {
    // The device the connect ticket was minted for. Undefined on the
    // loopback, whose caller is this machine.
    readonly deviceId: string | undefined;
    // Aborts when the link is gone.
    readonly closed: AbortSignal;
    // The link's byte channels: a handler that opens one for the peer
    // attaches its far end here under the id the peer minted.
    readonly channels: LinkChannels;
    // A push for this peer alone (a move's progress), on the stream
    // the peer reads that push from.
    readonly notify: <M extends ContractModule, K extends BroadcastKeys<M>>(
      module: M,
      key: K,
      payload: BroadcastProducerPayload<M, K>,
    ) => void;
  }
>()("sm/remote/LinkPeer") {}

// Refuses every call but the handshake until the hello was accepted,
// and hands the handler the peer.
export class PeerAuth extends RpcMiddleware.Service<
  PeerAuth,
  { provides: LinkPeer }
>()("sm/remote/PeerAuth", {
  error: Schema.Union([LinkUnauthenticatedError, RemoteCallError]),
}) {}

// The command switch (contract.ts, Gated): a call annotated gated:false
// runs for every peer, and any other, a missing annotation included,
// only while the host's switch is on, or as a call the host itself
// invited the peer to make.
export class CommandGate extends RpcMiddleware.Service<
  CommandGate,
  { requires: LinkPeer }
>()("sm/remote/CommandGate", { error: CommandRefusedError }) {}

const handshake = new Set(["link:challenge", "link:hello"]);

const groupOf = (calls: ReturnType<typeof callsOf>) =>
  RpcGroup.make(
    ...calls.filter((call) => handshake.has(channelOf(call))),
  ).merge(
    RpcGroup.make(...calls.filter((call) => !handshake.has(channelOf(call))))
      .middleware(CommandGate)
      .middleware(PeerAuth),
  );

// Every call a peer may make, each module's calls annotated `remote`
// and the link's own, and every host push: one not annotated `remote`
// reaches a peer only as its own call's push (a move's progress), never
// as a fan-out.
const remoteCalls = [linkContract, ...allContractModules].flatMap((module) =>
  callsOf(module).filter(
    (call) =>
      annotation(call, Remote) === true ||
      (isBroadcast(call) && scopeOf(module) === "host"),
  ),
);

export const LinkGroup = groupOf(remoteCalls);

// The loopback: the same link on this machine, for the processes the
// app's own credential admits (the terminal `sm`, the app's own
// windows). It serves the link's own calls, every call of every
// host-scope module, remote or not, with its pushes and views, and the
// control contract's ops.
export const LoopbackGroup = groupOf([
  ...callsOf(linkContract),
  ...allContractModules
    .filter((module) => scopeOf(module) === "host")
    .flatMap((module) => callsOf(module)),
  ...callsOf(controlContract),
]);
