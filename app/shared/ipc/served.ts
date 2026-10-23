// What a side serves, module by module, for its RPC server to answer
// the group's calls from (host/socket/DeviceLink.ts, main/ipc/ShellLink.ts,
// web/ipc/localRegistrar.ts). A module registers whole or not at all:
// every invoke needs a handler, and a host call that never classified
// itself is refused at registration (classificationGap). The server's
// group decodes each payload and encodes each answer with the call's
// own schemas, so a handler sees only what its call's input schema let
// through.
import {
  annotation,
  type ContractCall,
  type ContractModule,
  callOf,
  callsOf,
  channelOf,
  Gated,
  Grant,
  isInvoke,
  isPush,
  keyOf,
  nameOf,
  payloadOf,
  Remote,
  Scope,
  TracksProjectUsage,
} from "@shigomori/contracts/contract";
import { decode } from "@shigomori/contracts/codec";
import { type CallFailure, callFailureOf } from "@shigomori/contracts/errors";
import type {
  EffectHandlers,
  Handlers,
  PushKeys,
  PushProducerPayload,
  ViewHandlers,
} from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

// Fails closed on a host call that never classified itself: a host
// invoke must say whether it is remote, a remote one whether it is
// gated, and a remote gated one which consent line covers it.
function classificationGap(call: ContractCall): string | null {
  if (isPush(call)) return null;
  const host = annotation(call, Scope) === "host";
  const remote = annotation(call, Remote);
  if (host && remote === undefined) {
    return `${channelOf(call)} does not say whether it is remote`;
  }
  const gated = remote === true ? annotation(call, Gated) : false;
  if (host && gated === undefined) {
    return `${channelOf(call)} is remote but does not say whether it is gated`;
  }
  // A grant names what the switch hands to other devices, so exactly
  // the remote gated host calls carry one.
  const handedOver = host && remote === true && gated === true;
  const grant = annotation(call, Grant);
  if (handedOver && grant === undefined) {
    return `${channelOf(call)} is remote and gated but names no grant`;
  }
  if (!handedOver && grant !== undefined) {
    return `${channelOf(call)} names a grant but the switch does not hand it over`;
  }
  return null;
}

// One invoke as the server runs it: the handler's answer, an effect, a
// promise or a value, as an effect whose failure crosses as the
// contract error it is, or as RemoteCallError (the side's `failure`).
export type Invoke<Ctx, Services, E = CallFailure> = (
  input: unknown,
  ctx: Ctx,
) => Effect.Effect<unknown, E, Services>;

export type View<Services> = (
  input: unknown,
) => Stream.Stream<unknown, unknown, Services>;

export type Served<Ctx, Services = never, E = CallFailure> = {
  readonly serve: <M extends ContractModule>(
    module: M,
    handlers: Handlers<M, Ctx> | EffectHandlers<M, Ctx, Services>,
  ) => void;
  // One call alone, as a proof serves just what it asks.
  readonly serveOne: <M extends ContractModule, K extends keyof Handlers<M>>(
    module: M,
    key: K,
    handler:
      | Handlers<M, Ctx>[K]
      | EffectHandlers<M, Ctx, Services>[K & keyof EffectHandlers<M>],
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
    // Which of a module's calls this side serves: the device link
    // serves only the remote ones, so a call that is not is never
    // there for a peer to ask.
    readonly serves?: (call: ContractCall) => boolean;
    // Runs after a call that opts in via TracksProjectUsage resolves,
    // with its input. Required whenever a module declares a tracked
    // call: registration throws otherwise.
    readonly onUsageTracked?: (input: unknown) => void;
  } = {},
): Served<Ctx, Services, E> {
  const serves = options.serves ?? (() => true);
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
  const check = (call: ContractCall, handler: unknown) => {
    const gap = classificationGap(call);
    if (gap !== null) throw new Error(gap);
    if (handler === undefined) {
      throw new Error(`no handler for ${channelOf(call)}`);
    }
    if (
      annotation(call, TracksProjectUsage) === true &&
      options.onUsageTracked === undefined
    ) {
      throw new Error(
        `${channelOf(call)} tracks project usage, and nothing here hears it`,
      );
    }
  };
  const mount = (
    call: ContractCall,
    handler: (input: unknown, ctx: Ctx) => unknown,
  ) => {
    if (!serves(call)) return;
    const tracked =
      annotation(call, TracksProjectUsage) === true
        ? options.onUsageTracked
        : undefined;
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
        Effect.tap(() => Effect.sync(() => tracked?.(input))),
      ),
    );
  };
  // The tables are typed per call and read here by key, which loses the
  // link between a call and its input type; the group's decode of each
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
      for (const call of calls) check(call, byKey[keyOf(call)]);
      for (const call of calls) {
        const handler = byKey[keyOf(call)];
        if (handler !== undefined) mount(call, handler);
      }
    },
    serveOne(module, key, handler) {
      const call = callOf(module, String(key));
      check(call, handler);
      // the group decodes every payload before a handler sees it
      mount(call, handler as (input: unknown, ctx: Ctx) => unknown);
    },
    view(module, handlers) {
      // typed per view above; read here by key
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

// A push as it goes out: its channel, whether a peer may hear it, and
// its payload decoded at the source, so a producer bug surfaces here
// rather than as a shape the far end can't read.
export function resolvePush<M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
  payload: PushProducerPayload<M, K>,
): { channel: string; payload: unknown; remote: boolean } {
  const call = callOf(module, key);
  if (!isPush(call)) {
    throw new Error(`${nameOf(module)}:${key} is not a push`);
  }
  return {
    channel: channelOf(call),
    payload: decode(payloadOf(call), payload),
    remote: annotation(call, Remote) === true,
  };
}
