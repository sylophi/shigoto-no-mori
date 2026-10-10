import {
  annotation,
  type ContractCall,
  type ContractModule,
  callOf,
  callsOf,
  channelOf,
  Gated,
  Grant,
  inputOf,
  isBroadcast,
  isInvoke,
  keyOf,
  outputOf,
  payloadOf,
  Remote,
  Scope,
  TracksProjectUsage,
} from "@shigomori/contracts/contract";
import { decode, encode } from "@shigomori/contracts/codec";
import { type CallFailure, callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import type {
  CallContext,
  EffectServerTransport,
  HandlerContext,
  ServerTransport,
} from "./transport";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  Handlers,
} from "@shigomori/contracts/types";

type RegisterContractOpts = {
  // Gates OUTPUT validation only, never input parsing. Bindings pass a
  // dev-build flag here so handler drift (or schemas whose encoded and
  // decoded shapes diverge) surfaces at the registrar instead of as a
  // confusing failure in the renderer.
  validateOutputs: boolean;
  // Runs after a handler whose call opts in via TracksProjectUsage
  // resolves, with the parsed input. The Electron binding hooks the
  // project usage bump here. Required whenever the module declares any
  // tracked call: registration throws otherwise, so a binding that
  // forgets the hook fails at startup instead of silently freezing the
  // usage sorts.
  onUsageTracked?: (parsedInput: unknown) => void;
};

type RegisterHostContractOpts = RegisterContractOpts & {
  // Runs a step of the call (the handler itself, the input's parse),
  // a throw failing it. The host's sets the call's span as the ambient
  // parent of a Promise handler's own.
  readonly invoke?: <A>(run: () => A) => Effect.Effect<A, CallFailure>;
};

// The per-call wrapper: ONE definition of what serving a contract call
// means, so dispatch policy cannot diverge between the wires the
// registrar loop below serves. Input parsing is
// UNCONDITIONAL, never gated by build type: the moment handlers are
// reachable over a socket, this parse is the wall between a malformed
// payload and git argv. The hook is resolved once here (an untracked
// call pays nothing per call): onUsageTracked runs only for a call
// opting in via TracksProjectUsage.
function wrapContractCall<Ctx>(
  call: ContractCall,
  handler: (input: unknown, ctx: Ctx) => unknown,
  opts: RegisterContractOpts,
): (ctx: Ctx, raw: unknown) => Promise<unknown> {
  const onSuccess =
    annotation(call, TracksProjectUsage) === true
      ? opts.onUsageTracked
      : undefined;
  return async (ctx, raw) => {
    const input = decode(inputOf(call), raw);
    const result = await handler(input, ctx);
    onSuccess?.(input);
    return opts.validateOutputs ? encode(outputOf(call), result) : result;
  };
}

// The same, as an effect for a server built in a layer graph: a handler
// answers with an effect on the graph's services, which runs where the
// call is served. The Promise path below (a value or a Promise, with a
// signal that aborts when the call is interrupted) is scaffolding for
// the handlers not converted yet, not a second way to write one: it
// goes with the last Promise handler (V3.md, the host's Promise
// adapters), so a new handler answers with an effect.
function wrapEffectCall<Services>(
  call: ContractCall,
  handler: (input: unknown, ctx: HandlerContext) => unknown,
  opts: RegisterHostContractOpts,
): (
  ctx: CallContext,
  raw: unknown,
) => Effect.Effect<unknown, CallFailure, Services> {
  const onSuccess =
    annotation(call, TracksProjectUsage) === true
      ? opts.onUsageTracked
      : undefined;
  const attempt =
    opts.invoke ??
    (<A>(run: () => A) => Effect.try({ try: run, catch: callFailureOf }));
  return (ctx, raw) =>
    Effect.gen(function* () {
      const input = yield* attempt(() => decode(inputOf(call), raw));
      const controller = new AbortController();
      const answer = yield* attempt(() =>
        handler(input, { ...ctx, signal: controller.signal }),
      );
      const result = yield* (
        Effect.isEffect(answer)
          ? (answer as Effect.Effect<unknown, unknown, Services>).pipe(
              Effect.mapError(callFailureOf),
            )
          : Effect.tryPromise({
              try: async () => answer,
              catch: callFailureOf,
            })
      ).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())));
      onSuccess?.(input);
      return opts.validateOutputs
        ? yield* attempt(() => encode(outputOf(call), result))
        : result;
    });
}

// Fails closed on a host call that never classified itself: a host
// invoke must say whether it is remote, a remote one whether it is
// gated, and a remote gated one which consent line covers it. Thrown at
// registration, so such a call never serves.
export function classificationGap(call: ContractCall): string | null {
  if (isBroadcast(call)) return null;
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

// Checks every call of `module` before any is mounted, so a module
// either serves whole or not at all, then mounts each with its
// exposure: `remote` so a composite wire can withhold a non-remote
// channel from the socket entirely, and `gated` RAW (undefined stays
// undefined, never collapsed to false) so the remote bindings'
// read-only collections stay fail-closed at the transport level too:
// they record a channel as servable-ungated only on an EXPLICIT
// gated:false, so a call that never classified itself is gated like a
// command rather than served as a read.
function mountCalls(
  module: ContractModule,
  handlers: object,
  opts: RegisterContractOpts,
  mount: (
    call: ContractCall,
    handler: (i: unknown, ctx: HandlerContext) => unknown,
    exposure: { remote: boolean; gated: boolean | undefined },
  ) => void,
): void {
  const calls = callsOf(module);
  const tracked = calls.find(
    (call) => annotation(call, TracksProjectUsage) === true,
  );
  if (tracked && opts.onUsageTracked === undefined) {
    throw new Error(
      `registerContract: the module containing "${channelOf(tracked)}" declares tracksProjectUsage but no onUsageTracked hook was passed`,
    );
  }
  // The table is typed per call and read below by name, which loses
  // the link between a call and its input type. Every call parses its
  // input before the handler sees it, so nothing rides on the claim.
  // oxlint-disable-next-line shigomori/no-double-cast -- the parse above each handler is the check
  const byName = handlers as unknown as Record<
    string,
    (i: unknown, ctx: HandlerContext) => unknown
  >;
  const invokes = calls.filter(isInvoke);
  for (const call of invokes) {
    const gap = classificationGap(call);
    if (gap !== null) throw new Error(`registerContract: ${gap}`);
    if (byName[keyOf(call)] === undefined) {
      throw new Error(`registerContract: no handler for "${channelOf(call)}"`);
    }
  }
  for (const call of invokes) {
    const handler = byName[keyOf(call)];
    if (handler === undefined) continue;
    mount(call, handler, {
      remote: annotation(call, Remote) === true,
      gated: annotation(call, Gated),
    });
  }
}

export function registerContract<M extends ContractModule>(
  module: M,
  handlers: Handlers<M, HandlerContext>,
  server: ServerTransport,
  opts: RegisterContractOpts,
): void {
  mountCalls(module, handlers, opts, (call, handler, exposure) =>
    server.handle(
      channelOf(call),
      wrapContractCall(call, handler, opts),
      exposure,
    ),
  );
}

// A contract served from a layer graph, its handlers free to answer
// with effects on the graph's services.
export function registerHostContract<M extends ContractModule, Services>(
  module: M,
  handlers: Handlers<M, HandlerContext, Services>,
  server: EffectServerTransport<Services>,
  opts: RegisterHostContractOpts,
): void {
  mountCalls(module, handlers, opts, (call, handler, exposure) =>
    server.handle(
      channelOf(call),
      wrapEffectCall<Services>(call, handler, opts),
      exposure,
    ),
  );
}

// Parse at source: a producer bug surfaces here rather than as a
// confusing shape mismatch in the renderer. Symmetric with input
// parsing at the registrar boundary for invoke calls.
export function resolveBroadcast<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(
  module: M,
  key: K,
  payload: BroadcastProducerPayload<M, K>,
): { channel: string; parsed: unknown; remote: boolean } {
  const call = callOf(module, key);
  // The key type narrows to broadcast calls, but a cast at a call site
  // can defeat it. Without this guard a wrong key surfaces as a crash
  // on a missing payload schema instead of a named error.
  if (!isBroadcast(call)) {
    throw new Error(`contract key "${key}" is not a broadcast`);
  }
  return {
    channel: channelOf(call),
    parsed: decode(payloadOf(call), payload),
    remote: annotation(call, Remote) === true,
  };
}

// Fan-out broadcast: parses the payload once, then hands the wire shape
// to the server transport for delivery to every connected peer. Living
// on the seam keeps host-scoped broadcasts working when the host side
// moves behind a socket. Window-targeted broadcasts stay in the
// Electron binding, since a single window is an Electron concept.
export function broadcastAll<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(
  module: M,
  key: K,
  payload: BroadcastProducerPayload<M, K>,
  server: Pick<ServerTransport, "broadcastAll">,
): void {
  const { channel, parsed, remote } = resolveBroadcast(module, key, payload);
  server.broadcastAll(channel, parsed, { remote });
}
