import type { z } from "zod";
import type { BroadcastDef, Contract, InvokeDef } from "./contract";

type InvokeKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends InvokeDef ? K : never;
}[keyof C];

type BroadcastKeys<C extends Contract> = {
  [K in keyof C]: C[K] extends BroadcastDef ? K : never;
}[keyof C];

type In<D> = D extends InvokeDef ? z.infer<D["input"]> : never;
type Out<D> = D extends InvokeDef ? z.infer<D["output"]> : never;
type Payload<D> = D extends BroadcastDef ? z.infer<D["payload"]> : never;

// z.void() infers as `void`, so a contract entry that takes no input should
// produce a zero-arg call signature on both the handler and client surfaces.
type Args<I> = [I] extends [void] ? [] : [input: I];

export type Handlers<C extends Contract> = {
  [K in InvokeKeys<C>]: (
    ...args: Args<In<C[K]>>
  ) => Promise<Out<C[K]>> | Out<C[K]>;
};

export type Client<C extends Contract> = {
  [K in InvokeKeys<C>]: (...args: Args<In<C[K]>>) => Promise<Out<C[K]>>;
} & {
  [K in BroadcastKeys<C>]: (handler: (p: Payload<C[K]>) => void) => () => void;
};
