import type { CallDef, ContractModule, InvokeDef } from "./contract";
import type { HandlerContext, ServerTransport } from "./transport";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  Handlers,
} from "./types";

export type RegisterContractOpts = {
  // Gates OUTPUT validation only, never input parsing. Bindings pass a
  // dev-build flag here so handler drift (or schemas whose z.input and
  // z.output diverge) surfaces at the registrar instead of as a
  // confusing failure in the renderer.
  validateOutputs: boolean;
  // Runs after a handler whose def opts in via `tracksProjectUsage`
  // resolves, with the parsed input. The Electron binding hooks the
  // project usage bump here. Required whenever the module declares any
  // tracked call: registration throws otherwise, so a binding that
  // forgets the hook fails at startup instead of silently freezing the
  // usage sorts.
  onUsageTracked?: (parsedInput: unknown) => void;
  // Runs after a handler whose def is tagged `mutating: true` resolves
  // (before output validation, which only dev builds run: the mutation
  // happened either way), whichever wire carried the call. The Electron
  // binding hangs the remote-viewer cache ping here: an app-driven
  // mutation never trips the fs watcher (its self-write suppression
  // exists to keep the app's own writes from echoing), so without this
  // a remote viewer would never learn the host's state moved. Optional,
  // since bindings with no remote push surface (the web bridge) omit
  // it. A def tagged movesHostState:false skips the hook: it is still a
  // command on the grant axis, but its effects are invisible to viewers
  // (forward's byte shuttling), so pinging on it would re-invalidate a
  // peer's whole cached view on every poll or send.
  onMutationResolved?: () => void;
};

// The per-call wrapper: ONE definition of what serving a contract call
// means, shared by the registrar loop below and any single-slot
// binding (the hub broker in host/ipc/modules/direct.ts), so
// dispatch policy cannot diverge between the wires. Input parsing is
// UNCONDITIONAL, never gated by build type: the moment handlers are
// reachable over a socket, this parse is the wall between a malformed
// payload and git argv. The hooks are resolved once here (an untracked
// non-mutating def pays nothing per call): onUsageTracked runs only
// for a def opting in via tracksProjectUsage, and onMutationResolved
// only for an explicit mutating:true def not opted out via
// movesHostState:false, exactly the rules RegisterContractOpts
// documents.
export function wrapContractCall<Ctx>(
  def: InvokeDef,
  handler: (input: unknown, ctx: Ctx) => unknown,
  opts: RegisterContractOpts,
): (ctx: Ctx, raw: unknown) => Promise<unknown> {
  const onSuccess = def.tracksProjectUsage ? opts.onUsageTracked : undefined;
  const onMutated =
    def.mutating === true && def.movesHostState !== false
      ? opts.onMutationResolved
      : undefined;
  return async (ctx, raw) => {
    const input = def.input.parse(raw);
    const result = await handler(input, ctx);
    onSuccess?.(input);
    onMutated?.();
    return opts.validateOutputs ? def.output.parse(result) : result;
  };
}

export function registerContract<M extends ContractModule>(
  module: M,
  handlers: Handlers<M, HandlerContext>,
  server: ServerTransport,
  opts: RegisterContractOpts,
): void {
  const tracked = Object.values(module.calls).find(
    (def) => def.kind === "invoke" && def.tracksProjectUsage,
  );
  if (tracked && opts.onUsageTracked === undefined) {
    throw new Error(
      `registerContract: the module containing "${tracked.channel}" declares tracksProjectUsage but no onUsageTracked hook was passed`,
    );
  }
  for (const [key, def] of Object.entries(module.calls)) {
    if (def.kind !== "invoke") continue;
    const handler = (
      handlers as unknown as Record<
        string,
        (i: unknown, ctx: HandlerContext) => unknown
      >
    )[key];
    // The def's exposure decision rides to the transport so a composite
    // wire can withhold a non-remote channel from the socket entirely.
    const remote = def.remote === true;
    // The command-vs-read decision rides RAW (undefined stays
    // undefined, never collapsed to false) so the remote bindings'
    // read-only collections stay fail-closed at the transport level
    // too: they record a channel as servable-ungated only on an
    // EXPLICIT mutating:false, so a def that never classified itself is
    // gated like a command rather than served as a read. The socket
    // check already forbids untagged remote invokes at the contract
    // level, and this keeps the property even for a def that escapes it.
    const mutating = def.mutating;
    server.handle(def.channel, wrapContractCall(def, handler, opts), {
      remote,
      mutating,
    });
  }
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
  const def: CallDef | undefined = module.calls[key];
  // The key type narrows to broadcast defs, but a cast at a call site
  // can defeat it. Without this guard a wrong key surfaces as a crash
  // on a missing payload schema instead of a named error.
  if (def?.kind !== "broadcast") {
    throw new Error(`contract key "${key}" is not a broadcast`);
  }
  return {
    channel: def.channel,
    parsed: def.payload.parse(payload),
    remote: def.remote === true,
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
  server: ServerTransport,
): void {
  const { channel, parsed, remote } = resolveBroadcast(module, key, payload);
  server.broadcastAll(channel, parsed, { remote });
}
