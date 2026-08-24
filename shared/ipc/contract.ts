import { z } from "zod";

export type InvokeDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  kind: "invoke";
  channel: string;
  input: I;
  output: O;
  // When true, a successful call counts as the user "using" the project named
  // by the payload's `projectId`, feeding the sidebar usage sorts. Opt-in so
  // reads and view-only preference changes never count; see the IPC registrar.
  tracksProjectUsage?: boolean;
};

export type BroadcastDef<P extends z.ZodTypeAny = z.ZodTypeAny> = {
  kind: "broadcast";
  channel: string;
  payload: P;
};

export type CallDef = InvokeDef | BroadcastDef;
export type Contract = Record<string, CallDef>;

// Every contract module tags its calls with the side that serves them.
// "host" calls run on the process that owns the projects, which may
// live on another machine one day. "client" calls stay on the machine
// the window runs on (native dialogs, shell, app menu). Remoteness is
// a property of the transport a scope is wired to, never of the calls
// themselves.
export type ContractScope = "host" | "client";

export type ContractModule<C extends Contract = Contract> = {
  scope: ContractScope;
  calls: C;
};

export const invoke = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  channel: string,
  input: I,
  output: O,
  opts?: { tracksProjectUsage?: boolean },
): InvokeDef<I, O> => ({
  kind: "invoke",
  channel,
  input,
  output,
  tracksProjectUsage: opts?.tracksProjectUsage ?? false,
});

export const broadcast = <P extends z.ZodTypeAny>(
  channel: string,
  payload: P,
): BroadcastDef<P> => ({ kind: "broadcast", channel, payload });

// Scope is deliberately not a type parameter. Today the only consumer
// is the runtime transport lookup in buildApi. A scope brand at the
// type level comes back when a layer needs to branch on it statically.
export const defineContract = <C extends Contract>(
  scope: ContractScope,
  calls: C,
): ContractModule<C> => ({ scope, calls });
