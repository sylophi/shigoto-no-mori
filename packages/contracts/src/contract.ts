// A push is a streaming Rpc with no payload, whose chunks are its
// payloads. A view is a streaming Rpc with a payload (VoidSchema when it
// takes nothing): what a query answers, then again each time it changes.
import * as Context from "effect/Context";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type { ContractSchema } from "./codec.ts";
import { CallFailureSchema } from "./errors.ts";
import type { GrantId } from "./grants.ts";

// "host": the process that owns the projects, this machine's or a
// peer's. "client": the machine the window runs on.
export type ContractScope = "host" | "client";

export type InvitableScope = "landing" | "copy" | "project";

const ModuleName = Context.Service<"sm/contracts/ModuleName", string>(
  "sm/contracts/ModuleName",
);
export const Scope = Context.Service<"sm/contracts/Scope", ContractScope>(
  "sm/contracts/Scope",
);

// Only calls annotated exactly true reach a peer. A host invoke must
// say, so a new call never joins the remote surface by a default.
export const Remote = Context.Service<"sm/contracts/Remote", boolean>(
  "sm/contracts/Remote",
);

// Served to another device only while the command switch is on: every
// call that changes what the user owns, and the reads kept behind it for
// what they disclose (arbitrary host paths, this host's bytes). A call
// that only refreshes a cache the host keeps for itself is ungated,
// though it spawns a process. A remote gated call names its Grant.
export const Gated = Context.Service<"sm/contracts/Gated", boolean>(
  "sm/contracts/Gated",
);

// A successful call counts as using the payload's `projectId` (the
// usage sorts).
export const TracksProjectUsage = Context.Service<
  "sm/contracts/TracksProjectUsage",
  boolean
>("sm/contracts/TracksProjectUsage");

// The switch's one exception: a gated call a mirror into this device
// makes, admitted by the invitation with the switch off, scoped to what
// the payload names ("copy": the copy's project and worktree, "project":
// its project only).
export const Invitable = Context.Service<
  "sm/contracts/Invitable",
  InvitableScope
>("sm/contracts/Invitable");

export const Grant = Context.Service<"sm/contracts/Grant", GrantId>(
  "sm/contracts/Grant",
);

type InvokeOptions = {
  readonly tracksProjectUsage?: boolean;
  readonly remote?: boolean;
  readonly gated?: boolean;
  readonly invitable?: InvitableScope;
  readonly grant?: GrantId;
};

// Only when given, so the registrar can fail closed on an absent one.
function annotationsOf(options: InvokeOptions): Context.Context<never> {
  let annotations = Context.empty();
  const add = <S>(key: Context.Key<string, S>, value: S | undefined) => {
    if (value !== undefined) annotations = Context.add(annotations, key, value);
  };
  add(TracksProjectUsage, options.tracksProjectUsage);
  add(Remote, options.remote);
  add(Gated, options.gated);
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
): Rpc.Rpc<Key, I, O, typeof CallFailureSchema> =>
  Rpc.make(key, {
    payload: input,
    success: output,
    error: CallFailureSchema,
  }).annotateMerge(annotationsOf(options)) as Rpc.Rpc<
    Key,
    I,
    O,
    typeof CallFailureSchema
  >;

export const push = <const Key extends string, P extends ContractSchema>(
  key: Key,
  payload: P,
  options: { readonly remote?: boolean } = {},
): Rpc.Rpc<Key, typeof Schema.Void, RpcSchema.Stream<P, typeof Schema.Never>> =>
  Rpc.make(key, { success: payload, stream: true }).annotateMerge(
    annotationsOf({ ...options, gated: false }),
  );

export const view = <
  const Key extends string,
  I extends ContractSchema,
  O extends ContractSchema,
>(
  key: Key,
  input: I,
  output: O,
  options: Pick<InvokeOptions, "remote" | "gated" | "grant"> = {},
): Rpc.Rpc<Key, I, RpcSchema.Stream<O, typeof CallFailureSchema>> =>
  Rpc.make(key, {
    payload: input,
    success: output,
    error: CallFailureSchema,
    stream: true,
  }).annotateMerge(annotationsOf(options)) as Rpc.Rpc<
    Key,
    I,
    RpcSchema.Stream<O, typeof CallFailureSchema>
  >;

// Read through its requests, so any module is one (RpcGroup itself is
// invariant).
export type ContractModule = RpcGroup.Any & {
  readonly requests: ReadonlyMap<string, Rpc.AnyWithProps>;
  readonly annotations: Context.Context<never>;
};

// The name and scope in the type only, never set at runtime.
export type Contract<
  Name extends string,
  S extends ContractScope,
  R extends Rpc.Any,
> = RpcGroup.RpcGroup<R> & {
  readonly "~contract"?: { readonly name: Name; readonly scope: S };
};

export const defineContract = <
  const Name extends string,
  const S extends ContractScope,
  const Rpcs extends ReadonlyArray<Rpc.Any>,
>(
  name: Name,
  scope: S,
  ...rpcs: Rpcs
): Contract<Name, S, Rpc.Prefixed<Rpcs[number], `${Name}:`>> => {
  // The group keys by tag, so a second call under one name would
  // silently replace the first.
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

export function nameOf(module: ContractModule): string {
  return required(module.annotations, ModuleName);
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

export type Streaming = {
  readonly successSchema: RpcSchema.Stream<Schema.Top, Schema.Top>;
};

export type Pushing = Streaming & {
  readonly payloadSchema: typeof Schema.Void;
};

export type CallsOf<M> = M extends {
  readonly requests: ReadonlyMap<string, infer R>;
}
  ? R
  : never;

export function callOf<M extends ContractModule, const K extends string>(
  module: M,
  key: K,
): Extract<CallsOf<M>, { readonly _tag: `${string}:${K}` }> {
  const name = required(module.annotations, ModuleName);
  const call = module.requests.get(`${name}:${key}`);
  if (call === undefined) throw new Error(`no call "${key}" in ${name}`);
  return call as Extract<CallsOf<M>, { readonly _tag: `${string}:${K}` }>;
}

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

export function keyOf(call: ContractCall): string {
  const channel = channelOf(call);
  return channel.slice(channel.indexOf(":") + 1);
}

export function channelOf(call: ContractCall): string {
  return call["_tag"];
}

// Read off the AST's tag, not by identity: the renderer's bundle can
// hold two copies of effect, and each has its own Schema.Void.
export function isPush(call: ContractCall): boolean {
  return (
    RpcSchema.isStreamSchema(call.successSchema) &&
    SchemaAST.isVoid(call.payloadSchema.ast)
  );
}

export function isInvoke(call: ContractCall): boolean {
  return !RpcSchema.isStreamSchema(call.successSchema);
}

export function payloadOf<R extends ContractCall>(call: R): PayloadOf<R> {
  if (!RpcSchema.isStreamSchema(call.successSchema)) {
    throw new Error(`${channelOf(call)} is not a push or a view`);
  }
  return call.successSchema.success as PayloadOf<R>;
}

export function annotation<S>(
  call: ContractCall,
  key: Context.Key<string, S>,
): S | undefined {
  return Context.getOrUndefined(call.annotations, key);
}
