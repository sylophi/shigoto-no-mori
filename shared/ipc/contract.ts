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
