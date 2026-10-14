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

// Producers give the wire shape (`Encoded`), consumers see `Decoded`;
// they diverge for defaults and transforms.

type Args<I> = [I] extends [void]
  ? []
  : undefined extends I
    ? [input?: I]
    : [input: I];

// Positional `(input, context)`: a void input still takes slot 0, or a
// void-input handler would typecheck as `(ctx) => ...` and receive
// undefined.
export type Handlers<M extends ContractModule, Ctx = unknown> = {
  [R in InvokesOf<M> as KeyOf<R["_tag"]>]: (
    input: Decoded<InputOf<R>>,
    context: Ctx,
  ) => Promise<Decoded<OutputOf<R>>> | Decoded<OutputOf<R>>;
};

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

export type ViewHandlers<M extends ContractModule, R> = {
  [V in ViewsOf<M> as KeyOf<V["_tag"]>]: (
    input: Decoded<InputOf<V>>,
  ) => Stream.Stream<Decoded<PayloadOf<V>>, unknown, R>;
};

export type ViewObserver<A> = {
  readonly value: (value: A) => void;
  readonly end: (failure?: unknown) => void;
};

type ContractInfo<M> = NonNullable<
  M extends { readonly "~contract"?: infer C } ? C : never
>;

export type EffectClient<M extends ContractModule> = {
  [R in InvokesOf<M> as KeyOf<R["_tag"]>]: (
    ...args: Args<Encoded<InputOf<R>>>
  ) => Effect.Effect<Decoded<OutputOf<R>>, unknown>;
};

export type EffectApi<M extends ContractModule> = {
  [K in M as ContractInfo<K> extends { readonly name: infer N extends string }
    ? N
    : never]: EffectClient<K>;
};

export type HostModulesOf<M extends ContractModule> = Extract<
  M,
  { readonly "~contract"?: { readonly scope: "host" } }
>;

export type PushKeys<M extends ContractModule> = KeyOf<PushesOf<M>["_tag"]>;

export type PushPayload<M extends ContractModule, K extends string> = Decoded<
  PayloadOf<Extract<PushesOf<M>, { readonly _tag: `${string}:${K}` }>>
>;

export type ViewKeys<M extends ContractModule> = KeyOf<ViewsOf<M>["_tag"]>;

type ViewOf<M extends ContractModule, K extends string> = Extract<
  ViewsOf<M>,
  { readonly _tag: `${string}:${K}` }
>;

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

// For something answering channels straight off the wire. A view is
// answered with its value as it reads now.
export type ChannelHandlers<M extends ContractModule> = {
  [R in InvokesOf<M> as R["_tag"]]: (
    input: Decoded<InputOf<R>>,
  ) => Promise<Decoded<OutputOf<R>>> | Decoded<OutputOf<R>>;
} & {
  [V in ViewsOf<M> as V["_tag"]]: (
    input: Decoded<InputOf<V>>,
  ) => Promise<Decoded<PayloadOf<V>>> | Decoded<PayloadOf<V>>;
};
