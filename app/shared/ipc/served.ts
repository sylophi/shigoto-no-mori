// What the shell and a web tab serve, module by module, for the shell's
// RPC server and the tab's link to answer from (main/ipc/ShellLink.ts,
// web/ipc/localRegistrar.ts). The host's are layers (host/socket/
// hostRpc.ts). A module registers whole or not at all:
// every invoke needs a handler. The server's group decodes each payload
// and encodes each answer with the call's own schemas, so a handler sees
// only what its call's input schema let through.
import {
  type ContractCall,
  type ContractModule,
  callsOf,
  channelOf,
  isInvoke,
  isPush,
  keyOf,
} from "@shigomori/contracts/contract";
import { type CallFailure, callFailureOf } from "@shigomori/contracts/errors";
import type {
  EffectHandlers,
  Handlers,
  ViewHandlers,
} from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

// One invoke as the server runs it: the handler's answer, an effect, a
// promise or a value, as an effect whose failure crosses as the
// contract error it is, or as RemoteCallError (the side's `failure`).
export type Invoke<Ctx, Services, E = CallFailure> = (
  input: unknown,
  ctx: Ctx,
) => Effect.Effect<unknown, E, Services>;

type View<Services> = (
  input: unknown,
) => Stream.Stream<unknown, unknown, Services>;

export type Served<Ctx, Services = never, E = CallFailure> = {
  readonly serve: <M extends ContractModule>(
    module: M,
    handlers: Handlers<M, Ctx> | EffectHandlers<M, Ctx, Services>,
  ) => void;
  readonly view: <M extends ContractModule>(
    module: M,
    views: ViewHandlers<M, Services>,
  ) => void;
  // What answers one of the group's calls, or undefined when nothing
  // here serves it.
  readonly invokeOf: (
    call: ContractCall,
  ) => Invoke<Ctx, Services, E> | undefined;
  readonly viewOf: (call: ContractCall) => View<Services> | undefined;
};

export function createServed<Ctx, Services = never, E = CallFailure>(
  options: {
    // What a handler's failure crosses as: callFailureOf on a wire, the
    // failure as it is in the page, which has none.
    readonly failure?: (error: unknown) => E;
  } = {},
): Served<Ctx, Services, E> {
  const failure =
    options.failure ?? ((error: unknown) => callFailureOf(error) as E);
  const invokes = new Map<string, Invoke<Ctx, Services, E>>();
  const views = new Map<string, View<Services>>();
  const once = (call: ContractCall) => {
    const channel = channelOf(call);
    if (invokes.has(channel) || views.has(channel)) {
      throw new Error(`${channel} is served already`);
    }
    return channel;
  };
  const mount = (
    call: ContractCall,
    handler: (input: unknown, ctx: Ctx) => unknown,
  ) => {
    invokes.set(once(call), (input, ctx) =>
      Effect.try({
        try: () => handler(input, ctx),
        catch: failure,
      }).pipe(
        Effect.flatMap((answer) =>
          Effect.isEffect(answer)
            ? (answer as Effect.Effect<unknown, unknown, Services>)
            : Effect.tryPromise({
                try: async () => answer,
                catch: failure,
              }),
        ),
        Effect.mapError(failure),
      ),
    );
  };
  // The tables are typed per call and read here by key, which loses the
  // link between a call and its input type. The group's decode of each
  // payload is the check.
  type ByKey = Record<
    string,
    ((input: unknown, ctx: Ctx) => unknown) | undefined
  >;
  return {
    serve(module, handlers) {
      // the group decodes every payload before a handler sees it
      const byKey = handlers as ByKey;
      const calls = callsOf(module).filter(isInvoke);
      const missing = calls.find((call) => byKey[keyOf(call)] === undefined);
      if (missing !== undefined) {
        throw new Error(`no handler for ${channelOf(missing)}`);
      }
      for (const call of calls) {
        const handler = byKey[keyOf(call)];
        if (handler !== undefined) mount(call, handler);
      }
    },
    view(module, handlers) {
      // typed per view above, read here by key
      const byKey = handlers as Record<string, View<Services> | undefined>;
      for (const call of callsOf(module)) {
        if (isPush(call) || isInvoke(call)) continue;
        // Every view is there on every wire: the device link's gates
        // decide which peers it reaches.
        const view = byKey[keyOf(call)];
        if (view === undefined) continue;
        views.set(once(call), view);
      }
    },
    invokeOf: (call) => invokes.get(channelOf(call)),
    viewOf: (call) => views.get(channelOf(call)),
  };
}
