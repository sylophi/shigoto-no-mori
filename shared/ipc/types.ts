import type { z } from "zod";
import type { BroadcastDef, Contract, InvokeDef } from "./contract";

type InvokeKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends InvokeDef ? K : never;
}[keyof C];

type BroadcastKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends BroadcastDef ? K : never;
}[keyof C];

// Inputs flow through `schema.parse(...)`. Producers (renderer client,
// broadcast caller) provide the wire shape (`z.input`); consumers
// (handler, broadcast subscriber) see the parsed shape (`z.output`).
// For plain object schemas the two collapse, but they diverge for
// z.coerce / preprocess / .default / .transform.
type ClientIn<D> = D extends InvokeDef ? z.input<D["input"]> : never;
type HandlerIn<D> = D extends InvokeDef ? z.output<D["input"]> : never;
type Out<D> = D extends InvokeDef ? z.output<D["output"]> : never;

type BroadcastSubscriberPayload<D> = D extends BroadcastDef
  ? z.output<D["payload"]>
  : never;

export type BroadcastProducerPayload<
  C extends Contract,
  K extends keyof C,
> = C[K] extends BroadcastDef ? z.input<C[K]["payload"]> : never;

// `z.void()` infers as `void`. Map void inputs to a zero-arg call so
// no-input calls don't force callers to pass `undefined`.
type Args<I> = [I] extends [void] ? [] : [input: I];

// Handlers receive an opaque context as a trailing argument so a handler
// can reach the underlying IPC event (e.g. to broadcast back to the
// sender) without the shared/ipc layer importing Electron. Main provides
// the concrete shape via the `Ctx` type parameter; renderer code never
// touches it. Handlers that ignore the context just omit the parameter,
// which is fine because TypeScript accepts callbacks with fewer params
// than the call signature requires.
export type Handlers<C extends Contract, Ctx = unknown> = {
  [K in InvokeKeys<C>]: (
    ...args: [...Args<HandlerIn<C[K]>>, context: Ctx]
  ) => Promise<Out<C[K]>> | Out<C[K]>;
};

export type Client<C extends Contract> = {
  [K in InvokeKeys<C>]: (...args: Args<ClientIn<C[K]>>) => Promise<Out<C[K]>>;
} & {
  [K in BroadcastKeys<C>]: (
    handler: (payload: BroadcastSubscriberPayload<C[K]>) => void,
  ) => () => void;
};
