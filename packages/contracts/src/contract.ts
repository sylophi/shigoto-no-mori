// A push is a streaming Rpc with no payload, whose chunks are its
// payloads. A view is a streaming Rpc with a payload (VoidSchema when it
// takes nothing): what a query answers, then again each time it changes.
import type { ChangeKind } from "./modules/session.ts";
import * as Context from "effect/Context";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { CallFailureSchema } from "./errors.ts";
import type { GrantId } from "./grants.ts";

// A schema a call carries. Its decoded value serializes to the JSON it
// decodes from, so the wires send values as they are and only decode.
export type ContractSchema = Schema.Codec<unknown, unknown>;

// "host": the process that owns the projects, this machine's or a
// peer's. "client": the machine the window runs on.
export type ContractScope = "host" | "client";

const ModuleName = Context.Service<"sm/contracts/ModuleName", string>(
  "sm/contracts/ModuleName",
);
const Scope = Context.Service<"sm/contracts/Scope", ContractScope>(
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

const Grant = Context.Service<"sm/contracts/Grant", GrantId>(
  "sm/contracts/Grant",
);

// The module's version (protocol.ts), on each of its calls.
const Version = Context.Service<"sm/contracts/Version", number>(
  "sm/contracts/Version",
);

// What a quit waits on the call for while it runs (the host's
// `changing`): the git work a person starts. One that ends in moments,
// or that nobody pressed, has none: a page's refresh as it opens
// (git:refreshProject) is not the refresh its button asks for
// (git:fetchProject), and a mirror's push into this repo
// (sync:receiveBundle) is its follower's.
export const Busy = Context.Service<"sm/contracts/Busy", ChangeKind>(
  "sm/contracts/Busy",
);

type InvokeOptions = {
  readonly tracksProjectUsage?: boolean;
  readonly remote?: boolean;
  readonly gated?: boolean;
  readonly grant?: GrantId;
  readonly busy?: ChangeKind;
};

export const ungated = { remote: true, gated: false } as const;

export const gatedBy = <const G extends GrantId>(grant: G) =>
  ({ remote: true, gated: true, grant }) as const;

export const trackedCodeChange = {
  ...gatedBy("changeCode"),
  tracksProjectUsage: true,
} as const;

// Only when given, so defineContract can fail closed on an absent one.
function annotationsOf(options: InvokeOptions): Context.Context<never> {
  let annotations = Context.empty();
  const add = <S>(key: Context.Key<string, S>, value: S | undefined) => {
    if (value !== undefined) annotations = Context.add(annotations, key, value);
  };
  add(TracksProjectUsage, options.tracksProjectUsage);
  add(Remote, options.remote);
  add(Gated, options.gated);
  add(Grant, options.grant);
  add(Busy, options.busy);
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

// Fails closed on a host call that never classified itself: a host
// invoke or view must say whether it is remote, a remote one whether it
// is gated, and a remote gated one which consent line covers it.
function classificationGap(
  channel: string,
  rpc: Rpc.AnyWithProps,
): string | null {
  if (isPush(rpc)) return null;
  const remote = annotation(rpc, Remote);
  if (remote === undefined) {
    return `${channel} does not say whether it is remote`;
  }
  const gated = remote ? annotation(rpc, Gated) : false;
  if (gated === undefined) {
    return `${channel} is remote but does not say whether it is gated`;
  }
  // A grant names what the switch hands to other devices, so exactly
  // the remote gated calls carry one.
  const grant = annotation(rpc, Grant);
  if (remote && gated && grant === undefined) {
    return `${channel} is remote and gated but names no grant`;
  }
  if (!(remote && gated) && grant !== undefined) {
    return `${channel} names a grant but the switch does not hand it over`;
  }
  return null;
}

// `remote: false` keeps every call of a host module off the device link
// (the loopback's own modules). `version` is for a module a build of
// another release calls, a peer's or the terminal `sm`'s (versionOf).
export const defineContract = <
  const Name extends string,
  const S extends ContractScope,
  const Rpcs extends ReadonlyArray<Rpc.Any>,
>(
  name: Name,
  scope:
    | S
    | {
        readonly scope: S;
        readonly remote?: false;
        readonly version?: number;
      },
  ...rpcs: Rpcs
): Contract<Name, S, Rpc.Prefixed<Rpcs[number], `${Name}:`>> => {
  // The group keys by tag, so a second call under one name would
  // silently replace the first.
  const keys = rpcs.map((rpc) => rpc["_tag"]);
  const twice = keys.find((key, i) => keys.indexOf(key) !== i);
  if (twice !== undefined) throw new Error(`${name}:${twice} is defined twice`);
  const {
    scope: scopeName,
    remote,
    version,
  } = typeof scope === "object"
    ? scope
    : { scope, remote: undefined, version: undefined };
  const group = RpcGroup.make(...rpcs)
    .prefix(`${name}:`)
    .annotate(ModuleName, name)
    .annotate(Scope, scopeName)
    .annotateRpcs(Scope, scopeName);
  const placed = remote === false ? group.annotateRpcs(Remote, false) : group;
  const module =
    version === undefined ? placed : placed.annotateRpcs(Version, version);
  if (scopeName === "host") {
    for (const [channel, rpc] of module.requests) {
      const gap = classificationGap(channel, rpc as Rpc.AnyWithProps);
      if (gap !== null) throw new Error(gap);
    }
  }
  // Fails closed on a module a peer reaches that never versioned
  // itself: the device link carries every remote call and every host
  // push (link.ts).
  if (
    version === undefined &&
    callsOf(module).some(
      (call) =>
        annotation(call, Remote) === true ||
        (scopeName === "host" && isPush(call)),
    )
  ) {
    throw new Error(`${name} reaches another device but names no version`);
  }
  return module;
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

export function moduleOf(call: ContractCall): string {
  const channel = channelOf(call);
  return channel.slice(0, channel.indexOf(":"));
}

// Undefined for a call only one build's own processes exchange: a
// module with no version, and in a versioned client module every call
// but the remote ones, which a window and its own shell exchange.
export function versionOf(call: ContractCall): number | undefined {
  return annotation(call, Scope) === "client" &&
    annotation(call, Remote) !== true
    ? undefined
    : annotation(call, Version);
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
