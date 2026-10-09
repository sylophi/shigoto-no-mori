// The device link: one websocket between two devices, carrying Effect
// RPC for every contract call a peer may make (the calls annotated
// `remote`), the pushes as streams, and the byte channels. Both ends
// build it from this one group, so a call, its middleware and its
// errors are described once: the host serves it (host/socket/), and
// the dialer (shared/remote/deviceLink.ts) and the web client call it.
//
// The link's own calls (modules/link.ts) open every connection: the
// handshake, which no middleware guards, then the rest, which PeerAuth
// guards (a call before an accepted hello is refused) and CommandGate
// classifies (a gated call runs only under the host's command switch,
// or as a call the host invited).
import {
  annotation,
  callsOf,
  channelOf,
  isBroadcast,
  Remote,
  scopeOf,
} from "@shigomori/contracts/contract";
import {
  CommandRefusedError,
  LinkUnauthenticatedError,
  RemoteCallError,
} from "@shigomori/contracts/errors";
import { linkContract } from "@shigomori/contracts/modules/link";
import * as Context from "effect/Context";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { allContractModules } from "@shared/ipc/client";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
} from "@shigomori/contracts/types";
import type { ContractModule } from "@shigomori/contracts/contract";
import type { ChannelHandle, ChannelEndpoint } from "./channels";

// How long a dial's handshake may take, from the socket opening to the
// welcome checked.
export const HELLO_TIMEOUT_MS = 10_000;

// Liveness. A websocket over a NAT, a tunnel edge or a laptop that just
// slept can die without either end seeing a close. The dialer pings on
// this interval and gives the link up when nothing has arrived for the
// timeout, which hands the keeper a drop to redial on. A probe (a wake
// from sleep, a tab coming back) asks for a verdict within
// PROBE_TIMEOUT_MS instead of waiting out the interval.
export const PING_INTERVAL_MS = 15_000;
export const PING_TIMEOUT_MS = 40_000;
export const PROBE_TIMEOUT_MS = 5_000;

// The host's side of the same rule: a peer silent this long is cut off,
// so a dead socket does not hold its slot. Generous next to the
// dialer's timeout: a hidden browser tab pings once a minute under
// timer throttling.
export const HOST_LIVENESS_TIMEOUT_MS = 120_000;

// Calls one peer may have running at once, its streams aside. Over it a
// call is refused rather than spawning yet another git or CLI process.
export const MAX_IN_FLIGHT_PER_PEER = 64;

// Byte channels one link may hold at once. A sanity bound against a
// runaway client, carved up on the dialing side between the forwards
// (main/core/portForward/engine.ts) and the mirror streams
// (main/core/mirror/gateway.ts).
export const MAX_CHANNELS_PER_LINK = 32;

// The peer on the other end of a link, once its hello was accepted:
// what a handler serving it reads, provided by PeerAuth.
export class LinkPeer extends Context.Service<
  LinkPeer,
  {
    // The device the connect ticket was minted for.
    readonly deviceId: string;
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

export const LinkGroup = RpcGroup.make(
  ...remoteCalls.filter((call) => handshake.has(channelOf(call))),
).merge(
  RpcGroup.make(
    ...remoteCalls.filter((call) => !handshake.has(channelOf(call))),
  )
    .middleware(CommandGate)
    .middleware(PeerAuth),
);
