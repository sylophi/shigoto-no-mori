// The types a contract module gives its two sides: the handler table
// that serves it and the client that calls it. Both key a call by its
// name, its channel without the module prefix. A client subscribes to a
// push as `on` and the push's capitalized name. A view is served as a
// stream, and watched with an observer on a wire that carries views.
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
type BroadcastsOf<M> = Extract<CallsOf<M>, Pushing>;
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
// when the input schema is void, the registrar still passes
// `undefined` in slot 0 so the `context` slot stays at index 1; using
// `Args<I>` here would let a void-input handler typecheck as
// `(ctx) => ...` and silently receive `undefined` at runtime.
// Handlers that don't need either argument can drop them via TypeScript
// variance (callbacks with fewer params are assignable). A side that
// serves its calls in a layer graph (the host) names the services in
// `Services`, and its handlers may answer with an effect on them.
export type Handlers<
  M extends ContractModule,
  Ctx = unknown,
  Services = never,
> = {
  [R in InvokesOf<M> as KeyOf<R["_tag"]>]: (
    input: Decoded<InputOf<R>>,
    context: Ctx,
  ) =>
    | Promise<Decoded<OutputOf<R>>>
    | Decoded<OutputOf<R>>
    | ([Services] extends [never]
        ? never
        : Effect.Effect<Decoded<OutputOf<R>>, unknown, Services>);
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

export type Client<M extends ContractModule> = {
  [V in ViewsOf<M> as KeyOf<V["_tag"]>]: (
    input: Encoded<InputOf<V>>,
    observer: ViewObserver<Decoded<PayloadOf<V>>>,
  ) => () => void;
} & {
  [R in InvokesOf<M> as KeyOf<R["_tag"]>]: (
    ...args: Args<Encoded<InputOf<R>>>
  ) => Promise<Decoded<OutputOf<R>>>;
} & {
  [R in BroadcastsOf<M> as `on${Capitalize<KeyOf<R["_tag"]>>}`]: (
    handler: (payload: BroadcastPayload<R>) => void,
  ) => () => void;
};

type ContractInfo<M> = NonNullable<
  M extends { readonly "~contract"?: infer C } ? C : never
>;

// The API over a set of modules (a union of them): one namespace per
// module, named for it, holding its client.
export type Api<M extends ContractModule> = {
  [K in M as ContractInfo<K> extends { readonly name: infer N extends string }
    ? N
    : never]: Client<K>;
};

// The API over the host-scoped modules of the set only.
export type HostApiOf<M extends ContractModule> = Api<
  Extract<M, { readonly "~contract"?: { readonly scope: "host" } }>
>;

// What a push's subscriber receives.
type BroadcastPayload<R> = Decoded<PayloadOf<R>>;

export type BroadcastKeys<M extends ContractModule> = KeyOf<
  BroadcastsOf<M>["_tag"]
>;

export type BroadcastProducerPayload<
  M extends ContractModule,
  K extends string,
> = Encoded<
  PayloadOf<Extract<BroadcastsOf<M>, { readonly _tag: `${string}:${K}` }>>
>;

// The invokes of M keyed by channel instead of call name, as one table:
// for something that answers channels straight off the wire. Same
// shapes as Handlers, minus the context.
export type ChannelHandlers<M extends ContractModule> = {
  [R in InvokesOf<M> as R["_tag"]]: (
    input: Decoded<InputOf<R>>,
  ) => Promise<Decoded<OutputOf<R>>> | Decoded<OutputOf<R>>;
};
