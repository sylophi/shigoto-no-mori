// The types a contract module gives its two sides: the handler table
// that serves it and the client that calls it. Both key a call by its
// name, its channel without the module prefix. A client's invokes are
// effects; a push and a view are streams, read by the module and the
// call's name.
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Decoded, Encoded } from "./codec.ts";
import type {
  CallsOf,
  ContractModule,
  InputOf,
  OutputOf,
  PayloadOf,
  Pushing,
  Streaming,
} from "./contract.ts";

type InvokesOf<M> = Exclude<CallsOf<M>, Streaming>;
type PushesOf<M> = Extract<CallsOf<M>, Pushing>;
type ViewsOf<M> = Exclude<Extract<CallsOf<M>, Streaming>, Pushing>;

type KeyOf<Tag> = Tag extends `${string}:${infer K}` ? K : never;

// Inputs are decoded on arrival. Producers (renderer client, broadcast
// caller) provide the wire shape (`Encoded`); consumers (handler,
// broadcast subscriber) see the decoded shape (`Decoded`). For plain
// object schemas the two collapse, but they diverge for defaults and
// transforms.

// A void input schema decodes to `void`. Map void inputs to a zero-arg call so
// no-input clients don't force callers to pass `undefined`, and an input
// that may be undefined to an optional argument.
type Args<I> = [I] extends [void]
  ? []
  : undefined extends I
    ? [input?: I]
    : [input: I];

// Handlers are always called positionally as `(input, context)`. Even
// when the input schema is void, the server still passes `undefined` in
// slot 0 so the `context` slot stays at index 1; using `Args<I>` here
// would let a void-input handler typecheck as `(ctx) => ...` and
// silently receive `undefined` at runtime. Handlers that don't need
// either argument can drop them via TypeScript variance (callbacks with
// fewer params are assignable).
export type Handlers<M extends ContractModule, Ctx = unknown> = {
  [R in InvokesOf<M> as KeyOf<R["_tag"]>]: (
    input: Decoded<InputOf<R>>,
    context: Ctx,
  ) => Promise<Decoded<OutputOf<R>>> | Decoded<OutputOf<R>>;
};

// The same for a side served from a layer graph (the host): each
// handler answers with an effect on the graph's services.
export type EffectHandlers<
  M extends ContractModule,
  Ctx = unknown,
  Services = never,
> = {
  [R in InvokesOf<M> as KeyOf<R["_tag"]>]: (
    input: Decoded<InputOf<R>>,
    context: Ctx,
  ) => Effect.Effect<Decoded<OutputOf<R>>, unknown, Services>;
};

// What serves a module's views: each one's stream, from its input.
export type ViewHandlers<M extends ContractModule, R> = {
  [V in ViewsOf<M> as KeyOf<V["_tag"]>]: (
    input: Decoded<InputOf<V>>,
  ) => Stream.Stream<Decoded<PayloadOf<V>>, unknown, R>;
};

// Who hears a view through a client: each value, then its end, with
// the failure when it did not end on its own.
export type ViewObserver<A> = {
  readonly value: (value: A) => void;
  readonly end: (failure?: unknown) => void;
};

type ContractInfo<M> = NonNullable<
  M extends { readonly "~contract"?: infer C } ? C : never
>;

// A module's invokes as effects, for a caller that runs on Effect (the
// renderer's client runtime, the host's link to its shell, the shell's
// session with its host, a peer's surface): each call's answer as its
// output decodes, and its failure as the far side sent it.
export type EffectClient<M extends ContractModule> = {
  [R in InvokesOf<M> as KeyOf<R["_tag"]>]: (
    ...args: Args<Encoded<InputOf<R>>>
  ) => Effect.Effect<Decoded<OutputOf<R>>, unknown>;
};

// The effect clients over a set of modules (a union of them): one
// namespace per module, named for it, holding its client.
export type EffectApi<M extends ContractModule> = {
  [K in M as ContractInfo<K> extends { readonly name: infer N extends string }
    ? N
    : never]: EffectClient<K>;
};

// The host-scoped modules of a set.
export type HostModulesOf<M extends ContractModule> = Extract<
  M,
  { readonly "~contract"?: { readonly scope: "host" } }
>;

export type PushKeys<M extends ContractModule> = KeyOf<PushesOf<M>["_tag"]>;

// What a push's reader receives.
export type PushPayload<M extends ContractModule, K extends string> = Decoded<
  PayloadOf<Extract<PushesOf<M>, { readonly _tag: `${string}:${K}` }>>
>;

export type ViewKeys<M extends ContractModule> = KeyOf<ViewsOf<M>["_tag"]>;

type ViewOf<M extends ContractModule, K extends string> = Extract<
  ViewsOf<M>,
  { readonly _tag: `${string}:${K}` }
>;

// What a view is asked with, and each value it gives.
export type ViewInput<M extends ContractModule, K extends string> = Encoded<
  InputOf<ViewOf<M, K>>
>;
export type ViewValue<M extends ContractModule, K extends string> = Decoded<
  PayloadOf<ViewOf<M, K>>
>;

export type PushProducerPayload<
  M extends ContractModule,
  K extends string,
> = Encoded<
  PayloadOf<Extract<PushesOf<M>, { readonly _tag: `${string}:${K}` }>>
>;

// The invokes of M keyed by channel instead of call name, as one table:
// for something that answers channels straight off the wire. Same
// shapes as Handlers, minus the context. A view is answered with its
// value as it reads now.
export type ChannelHandlers<M extends ContractModule> = {
  [R in InvokesOf<M> as R["_tag"]]: (
    input: Decoded<InputOf<R>>,
  ) => Promise<Decoded<OutputOf<R>>> | Decoded<OutputOf<R>>;
} & {
  [V in ViewsOf<M> as V["_tag"]]: (
    input: Decoded<InputOf<V>>,
  ) => Promise<Decoded<PayloadOf<V>>> | Decoded<PayloadOf<V>>;
};
