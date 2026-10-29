// The handshake is the one call no middleware guards.
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
  isPush,
  Remote,
  nameOf,
  scopeOf,
} from "./contract.ts";
import {
  CommandRefusedError,
  LinkUnauthenticatedError,
  NotSharingError,
  RemoteCallError,
} from "./errors.ts";
import { controlContract } from "./modules/control.ts";
import { guideDriveContract } from "./modules/guide.ts";
import { loginContract } from "./modules/login.ts";
import { sessionContract } from "./modules/session.ts";
import { shellCallsContract } from "./modules/shellCalls.ts";
import { linkContract } from "./modules/link.ts";
import type { PushKeys, PushProducerPayload } from "./types.ts";

// Twice layerSchemaBinary's default: a 16 MiB media file crosses as
// base64 in one frame, about 21.4 MiB with its envelope.
export const LINK_MAX_FRAME_BYTES = 32 * 1024 * 1024;

// The standard "try again later" a link's listener closes with: at its
// cap, or unable to check a ticket now (the account's roster
// unavailable). Nothing against the dialer, which reads it as busy.
export const CLOSE_TRY_AGAIN = 1013;

export type ChannelEndpoint = {
  // Call `consumed` once the sink has taken them: calling it early
  // defeats backpressure.
  onData(data: Uint8Array, consumed: () => void): void;
  // This side may still write until it ends too.
  onEnd(): void;
  // Reset, or the link died: both directions are over.
  onReset(): void;
  onComplete?(): void;
  onWritable(): void;
};

export type ChannelHandle = {
  readonly channelId: string;
  // False past the window: pause the source until onWritable.
  write(data: Uint8Array): boolean;
  end(): void;
  reset(): void;
  readonly open: boolean;
};

export type LinkChannels = {
  attach(channelId: string, endpoint: ChannelEndpoint): ChannelHandle;
  has(channelId: string): boolean;
  size(): number;
};

export class LinkPeer extends Context.Service<
  LinkPeer,
  {
    // Undefined on the loopback.
    readonly deviceId: string | undefined;
    readonly closed: AbortSignal;
    readonly channels: LinkChannels;
    // A push for this peer alone (a move's progress).
    readonly notify: <M extends ContractModule, K extends PushKeys<M>>(
      module: M,
      key: K,
      payload: PushProducerPayload<M, K>,
    ) => void;
  }
>()("sm/remote/LinkPeer") {}

export class PeerAuth extends RpcMiddleware.Service<
  PeerAuth,
  { provides: LinkPeer }
>()("sm/remote/PeerAuth", {
  error: Schema.Union([LinkUnauthenticatedError, RemoteCallError]),
}) {}

// Anything not annotated gated:false, a missing annotation included,
// runs only while the switch is on.
export class CommandGate extends RpcMiddleware.Service<
  CommandGate,
  { requires: LinkPeer }
>()("sm/remote/CommandGate", { error: CommandRefusedError }) {}

// Off, every call but the link's own is refused, reads
// included, and one under way ends. A push passes, carrying only what the
// host still lets this peer hear.
export class SharingGate extends RpcMiddleware.Service<
  SharingGate,
  { requires: LinkPeer }
>()("sm/remote/SharingGate", { error: NotSharingError }) {}

// The client-scoped modules whose state lives with the host.
const hostSideClientModules = new Set(["hub", "portForward"]);

export const isHostSide = (module: ContractModule): boolean =>
  scopeOf(module) === "host" || hostSideClientModules.has(nameOf(module));

const handshake = new Set(["link:hello"]);

type Calls = ReturnType<typeof callsOf>;

const handshakeOf = (calls: Calls) =>
  RpcGroup.make(...calls.filter((call) => handshake.has(channelOf(call))));

const restOf = (calls: Calls) =>
  RpcGroup.make(...calls.filter((call) => !handshake.has(channelOf(call))));

// Every host push is here: one not annotated `remote` reaches a peer
// only as its own call's push, never as a fan-out.
const remoteCalls = [linkContract, ...allContractModules].flatMap((module) =>
  callsOf(module).filter(
    (call) =>
      annotation(call, Remote) === true ||
      (isPush(call) && scopeOf(module) === "host"),
  ),
);

export const LinkGroup = handshakeOf(remoteCalls).merge(
  restOf(remoteCalls)
    .middleware(CommandGate)
    .middleware(SharingGate)
    .middleware(PeerAuth),
);

// For the processes the app's own credential admits. The session module
// opens only to a hello with the shell's own token.
const loopbackCalls = [
  ...callsOf(linkContract),
  ...allContractModules
    .filter((module) => isHostSide(module))
    .flatMap((module) => callsOf(module)),
  ...callsOf(controlContract),
  ...callsOf(guideDriveContract),
  ...callsOf(loginContract),
  ...callsOf(sessionContract),
];

export const LoopbackGroup = handshakeOf(loopbackCalls).merge(
  restOf(loopbackCalls).middleware(CommandGate).middleware(PeerAuth),
);

export const ShellCallsGroup = RpcGroup.make(...callsOf(shellCallsContract));
