import type {
  BroadcastDef,
  Contract,
  ContractModule,
  InvokeDef,
} from "./contract";
import type { Decoded, Encoded } from "./schema";

// Internals stay keyed on Contract. The public aliases at the bottom
// unwrap M["calls"] exactly once, so module wrapping never leaks into
// the mapped-type machinery.
type InvokeKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends InvokeDef ? K : never;
}[keyof C];

type BroadcastKeysOf<C extends Contract> = {
  [K in keyof C]: C[K] extends BroadcastDef ? K : never;
}[keyof C];

// Inputs are decoded on arrival. Producers (renderer client, broadcast
// caller) provide the wire shape (`Encoded`); consumers (handler,
// broadcast subscriber) see the decoded shape (`Decoded`). For plain
// object schemas the two collapse, but they diverge for defaults and
// transforms.
type ClientIn<D> = D extends InvokeDef ? Encoded<D["input"]> : never;
type HandlerIn<D> = D extends InvokeDef ? Decoded<D["input"]> : never;
type Out<D> = D extends InvokeDef ? Decoded<D["output"]> : never;

type BroadcastSubscriberPayload<D> = D extends BroadcastDef
  ? Decoded<D["payload"]>
  : never;

type BroadcastProducerPayloadOf<
  C extends Contract,
  K extends keyof C,
> = C[K] extends BroadcastDef ? Encoded<C[K]["payload"]> : never;

// A void input schema decodes to `void`. Map void inputs to a zero-arg call so
// no-input clients don't force callers to pass `undefined`.
type Args<I> = [I] extends [void] ? [] : [input: I];

// Handlers are always called positionally as `(input, context)`. Even
// when the input schema is void, the registrar still passes
// `undefined` in slot 0 so the `context` slot stays at index 1; using
// `Args<I>` here would let a void-input handler typecheck as
// `(ctx) => ...` and silently receive `undefined` at runtime.
// Handlers that don't need either argument can drop them via TypeScript
// variance (callbacks with fewer params are assignable).
type HandlersOf<C extends Contract, Ctx> = {
  [K in InvokeKeys<C>]: (
    input: HandlerIn<C[K]>,
    context: Ctx,
  ) => Promise<Out<C[K]>> | Out<C[K]>;
};

type ClientOf<C extends Contract> = {
  [K in InvokeKeys<C>]: (...args: Args<ClientIn<C[K]>>) => Promise<Out<C[K]>>;
} & {
  [K in BroadcastKeysOf<C>]: (
    handler: (payload: BroadcastSubscriberPayload<C[K]>) => void,
  ) => () => void;
};

// Public surface, keyed on the module.
export type BroadcastKeys<M extends ContractModule> = BroadcastKeysOf<
  M["calls"]
> &
  string;

export type BroadcastProducerPayload<
  M extends ContractModule,
  K extends keyof M["calls"],
> = BroadcastProducerPayloadOf<M["calls"], K>;

export type Handlers<M extends ContractModule, Ctx = unknown> = HandlersOf<
  M["calls"],
  Ctx
>;

export type Client<M extends ContractModule> = ClientOf<M["calls"]>;

// Every invoke def of M, or of each module when M is a union of them.
type InvokeDefsOf<M> = M extends ContractModule
  ? Extract<M["calls"][keyof M["calls"]], InvokeDef>
  : never;

// The invokes of M keyed by channel instead of call name, as one table:
// for something that answers channels straight off the wire. Same
// shapes as Handlers, minus the context.
export type ChannelHandlers<M extends ContractModule> = {
  [D in InvokeDefsOf<M> as D["channel"]]: (
    input: HandlerIn<D>,
  ) => Promise<Out<D>> | Out<D>;
};
