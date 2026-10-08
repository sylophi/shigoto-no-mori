// A contract module is an RpcGroup: one Rpc per call, tagged with its
// channel (`<module>:<key>`), and the call's classification as
// annotations on it, which the registrar and the transports read. An
// invoke is a plain Rpc. A push (what the transport still calls a
// broadcast) is a streaming Rpc whose chunks are its payloads.
// effect/rpc is @stability unstable in the pinned Effect (V3.md, decision
// 1: pinned exactly, bumped in its own PR), and this module is where the
// contracts meet it, so the unstable-API warning is off here only.
// @effect-diagnostics unstableApiUsage:off
import * as Context from "effect/Context";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import type { ContractSchema } from "./codec.ts";
import type { GrantId } from "./grants.ts";

// Every contract module tags its calls with the side that serves them.
// "host" calls run on the process that owns the projects, which may
// live on another machine one day. "client" calls stay on the machine
// the window runs on (native dialogs, shell, app menu). Remoteness is
// a property of the transport a scope is wired to, never of the calls
// themselves.
export type ContractScope = "host" | "client";

// The mirror invitation's scopes (see Invitable).
export type InvitableScope = "landing" | "copy" | "project";

// The module's own annotations: its name (the channel prefix) and its
// scope.
const ModuleName = Context.Service<"sm/contracts/ModuleName", string>(
  "sm/contracts/ModuleName",
);
export const Scope = Context.Service<"sm/contracts/Scope", ContractScope>(
  "sm/contracts/Scope",
);

// Exposure axis, independent of scope. Only calls annotated true reach
// a remote websocket peer (main/ipc/register.ts routes them to the ws
// binding). A host-scoped invoke MUST say, so a new call can never
// silently join the remote surface by inheriting a default. Anything
// other than exactly true is local-only. On a push, only one annotated
// true reaches remote peers, so a push carrying host-only detail is
// local by default.
export const Remote = Context.Service<"sm/contracts/Remote", boolean>(
  "sm/contracts/Remote",
);

// The gate axis for the direct listener. Gated true marks a call served
// to another device only while this host's command-access switch is on
// (host/socket/server.ts's dispatch gate, the one place that decides).
// That is every call that changes state the user owns (writes files or
// config, runs a script, moves a branch or a worktree), and also a few
// READS kept behind the switch because of what they disclose:
// fs:listDirectory, fs:scanForGitRepos, fs:isGitRepo, runtime:info,
// cli:status, cli:shellStatus and the sync reads that name arbitrary
// host paths (worktreeFolder, ignoredPaths, hasCommits), plus the source
// links, stream and mirror-state calls that hand a peer this host's
// bytes. So the name is the gate, not the effect. Gated false is served
// to every account peer. A call that only refreshes a cache the host
// keeps for itself (a fetch of remote-tracking refs, a gh listing) is
// ungated even though it spawns a process and touches the network. A
// remote host invoke must say (the registrar fails closed), while
// client-scoped and local-only calls never reach the gate. A remote
// gated call is something the switch hands to other devices, so it
// names the consent line that covers it (Grant).
export const Gated = Context.Service<"sm/contracts/Gated", boolean>(
  "sm/contracts/Gated",
);

// Whether a resolved gated call moved host state a remote viewer
// caches. Absent reads as true for a gated invoke: the registrar fires
// onMutationResolved (the remote-viewer cache ping) unless a call says
// exactly false. False only on gated channels whose effects are
// invisible to viewers, like forward's byte shuttling, so an open
// stream does not re-invalidate a peer's cached view of this host on
// every poll or send resolution. Orthogonal to Gated, which stays true
// on such channels.
export const MovesHostState = Context.Service<
  "sm/contracts/MovesHostState",
  boolean
>("sm/contracts/MovesHostState");

// When true, a successful call counts as the user "using" the project
// named by the payload's `projectId`, feeding the sidebar usage sorts.
// Opt-in so reads and view-only preference changes never count.
export const TracksProjectUsage = Context.Service<
  "sm/contracts/TracksProjectUsage",
  boolean
>("sm/contracts/TracksProjectUsage");

// The switch's one exception: a gated call a mirror INTO this device
// makes, which the invitation the ask left (host/mirror/invites.ts)
// admits with the switch off, scoped to what the payload names.
// "landing" is the peer's landing of the invited original
// (sync:receiveWorktree), "copy" a call naming the copy's project and
// worktree, "project" one naming only the copy's project. Set on the
// contract, next to the call, so the invited surface cannot drift from
// the calls a mirror makes.
export const Invitable = Context.Service<
  "sm/contracts/Invitable",
  InvitableScope
>("sm/contracts/Invitable");

// The consent line (grants.ts) that covers a remote gated call, the
// words the command switch shows for what it hands to other devices.
export const Grant = Context.Service<"sm/contracts/Grant", GrantId>(
  "sm/contracts/Grant",
);

type InvokeOptions = {
  readonly tracksProjectUsage?: boolean;
  readonly remote?: boolean;
  readonly gated?: boolean;
  readonly movesHostState?: boolean;
  readonly invitable?: InvitableScope;
  readonly grant?: GrantId;
};

// The options as annotations, each one only when given, so an absent
// classification stays absent and the registrar can fail closed on it.
function annotationsOf(options: InvokeOptions): Context.Context<never> {
  let annotations = Context.empty();
  const add = <S>(key: Context.Key<string, S>, value: S | undefined) => {
    if (value !== undefined) annotations = Context.add(annotations, key, value);
  };
  add(TracksProjectUsage, options.tracksProjectUsage);
  add(Remote, options.remote);
  add(Gated, options.gated);
  add(MovesHostState, options.movesHostState);
  add(Invitable, options.invitable);
  add(Grant, options.grant);
  return annotations as Context.Context<never>;
}

export const invoke = <
  const Key extends string,
  I extends ContractSchema,
  O extends ContractSchema,
>(
  key: Key,
  input: I,
  output: O,
  options: InvokeOptions = {},
): Rpc.Rpc<Key, I, O> =>
  Rpc.make(key, { payload: input, success: output }).annotateMerge(
    annotationsOf(options),
  ) as Rpc.Rpc<Key, I, O>;

export const broadcast = <const Key extends string, P extends ContractSchema>(
  key: Key,
  payload: P,
  options: { readonly remote?: boolean } = {},
): Rpc.Rpc<Key, typeof Schema.Void, RpcSchema.Stream<P, typeof Schema.Never>> =>
  Rpc.make(key, { success: payload, stream: true }).annotateMerge(
    annotationsOf(options),
  );

// A contract module: the group of its calls, each tagged with its
// channel, annotated with the module's name and scope (each call
// carries the scope too). Read through its requests, so any module is
// one (RpcGroup itself is invariant).
export type ContractModule = RpcGroup.Any & {
  readonly requests: ReadonlyMap<string, Rpc.AnyWithProps>;
  readonly annotations: Context.Context<never>;
};

export const defineContract = <
  const Name extends string,
  const Rpcs extends ReadonlyArray<Rpc.Any>,
>(
  name: Name,
  scope: ContractScope,
  ...rpcs: Rpcs
): RpcGroup.RpcGroup<Rpc.Prefixed<Rpcs[number], `${Name}:`>> => {
  // The group keys its calls by tag, so a second call under one name
  // would replace the first without a word.
  const keys = rpcs.map((rpc) => rpc["_tag"]);
  const twice = keys.find((key, i) => keys.indexOf(key) !== i);
  if (twice !== undefined) throw new Error(`${name}:${twice} is defined twice`);
  return RpcGroup.make(...rpcs)
    .prefix(`${name}:`)
    .annotate(ModuleName, name)
    .annotate(Scope, scope)
    .annotateRpcs(Scope, scope);
};

// ---- Reading a module ----

export type ContractCall = Rpc.AnyWithProps;

export function scopeOf(module: ContractModule): ContractScope {
  return required(module.annotations, Scope);
}

function required<S>(
  annotations: Context.Context<never>,
  key: Context.Key<string, S>,
): S {
  const value = Context.getOrUndefined(annotations, key);
  if (value === undefined)
    throw new Error(`a contract module lacks ${key.key}`);
  return value;
}

export function callsOf(module: ContractModule): ContractCall[] {
  return [...module.requests.values()];
}

// A push, as a type: its success is a stream.
export type Streaming = {
  readonly successSchema: RpcSchema.Stream<Schema.Top, Schema.Top>;
};

// The calls of a module, as a union of their Rpc types.
export type CallsOf<M> = M extends {
  readonly requests: ReadonlyMap<string, infer R>;
}
  ? R
  : never;

// One call of a module by its name, typed as it was defined.
export function callOf<M extends ContractModule, const K extends string>(
  module: M,
  key: K,
): Extract<CallsOf<M>, { readonly _tag: `${string}:${K}` }> {
  const name = required(module.annotations, ModuleName);
  const call = module.requests.get(`${name}:${key}`);
  if (call === undefined) throw new Error(`no call "${key}" in ${name}`);
  return call as Extract<CallsOf<M>, { readonly _tag: `${string}:${K}` }>;
}

// A call's schemas as it was defined: an invoke's input and output, a
// push's payload (the stream's chunk).
export type InputOf<R> = R extends {
  readonly payloadSchema: infer P extends ContractSchema;
}
  ? P
  : ContractSchema;
export type OutputOf<R> = R extends {
  readonly successSchema: infer S extends ContractSchema;
}
  ? S
  : ContractSchema;
export type PayloadOf<R> = R extends {
  readonly successSchema: RpcSchema.Stream<
    infer A extends ContractSchema,
    Schema.Top
  >;
}
  ? A
  : ContractSchema;

export function inputOf<R extends ContractCall>(call: R): InputOf<R> {
  return call.payloadSchema as InputOf<R>;
}

export function outputOf<R extends ContractCall>(call: R): OutputOf<R> {
  return call.successSchema as OutputOf<R>;
}

// The name the client and the handler table use for a call: its
// channel without the module prefix.
export function keyOf(call: ContractCall): string {
  const channel = channelOf(call);
  return channel.slice(channel.indexOf(":") + 1);
}

// The call's channel on the wire, its tag.
export function channelOf(call: ContractCall): string {
  return call["_tag"];
}

export function isBroadcast(call: ContractCall): boolean {
  return RpcSchema.isStreamSchema(call.successSchema);
}

export function payloadOf<R extends ContractCall>(call: R): PayloadOf<R> {
  if (!RpcSchema.isStreamSchema(call.successSchema)) {
    throw new Error(`${channelOf(call)} is not a push`);
  }
  return call.successSchema.success as PayloadOf<R>;
}

// An annotation the call carries, or undefined when it never classified
// itself.
export function annotation<S>(
  call: ContractCall,
  key: Context.Key<string, S>,
): S | undefined {
  return Context.getOrUndefined(call.annotations, key);
}
