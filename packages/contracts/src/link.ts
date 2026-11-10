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
  type ContractCall,
  type ContractModule,
  isPush,
  moduleOf,
  Remote,
  nameOf,
  scopeOf,
  versionOf,
} from "./contract.ts";
import {
  CommandRefusedError,
  LinkUnauthenticatedError,
  ModuleOutdatedError,
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

// Where the app publishes its loopback listener, in its data dir.
export const LOOPBACK_FILE = "loopback.json";

// What loopback.json holds: the host's pid, the loopback's port and
// token, and the app's version. Written aside first, at
// loopbackPartialOf, and renamed in.
export const LoopbackFile = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    port: Schema.Int,
    token: Schema.String,
    appVersion: Schema.String,
  }),
);

export const loopbackPartialOf = (file: string, pid: number) =>
  `${file}.${pid}`;

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

// The version of each module a group carries, by name: what a host's
// welcome says, and what the dialing end holds it against.
export type ModuleVersions = Readonly<Record<string, number>>;

type Group = { readonly requests: ReadonlyMap<string, ContractCall> };

export const versionsOf = (group: Group): ModuleVersions => {
  const versions: Record<string, number> = {};
  for (const call of group.requests.values()) {
    const version = versionOf(call);
    if (version !== undefined) versions[moduleOf(call)] = version;
  }
  return versions;
};

const linkVersions = versionsOf(LinkGroup);

// Why a call is not sent to a host: its welcome named another version
// for the call's module, or none, as a build older than the module
// does.
export const outdatedCall = (
  call: ContractCall,
  host: { readonly deviceId: string; readonly versions: ModuleVersions },
): ModuleOutdatedError | undefined => {
  const mine = versionOf(call);
  if (mine === undefined) return undefined;
  const module = moduleOf(call);
  const theirs = host.versions[module] ?? 0;
  return mine === theirs
    ? undefined
    : new ModuleOutdatedError({
        module,
        outdated: theirs < mine ? "peer" : "this",
        deviceId: host.deviceId,
      });
};

// The end on the older build.
export type OutdatedSide = ModuleOutdatedError["outdated"];

// What of a peer this build can't call, by its welcome: the modules the
// two hold at different versions, and the end on the older build.
// Undefined when they agree on every module this build calls. Releases
// are a line, so one end is the older in every module that differs.
export const outdatedModules = (
  theirs: ModuleVersions,
): { side: OutdatedSide; modules: string[] } | undefined => {
  const modules = Object.entries(linkVersions).filter(
    ([module, mine]) => (theirs[module] ?? 0) !== mine,
  );
  if (modules.length === 0) return undefined;
  return {
    side: modules.some(([module, mine]) => (theirs[module] ?? 0) < mine)
      ? "peer"
      : "this",
    modules: modules.map(([module]) => module),
  };
};

export const ShellCallsGroup = RpcGroup.make(...callsOf(shellCallsContract));
