import type { CallDef, ContractModule } from "./contract";
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
};

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
    // Resolved once at registration, so untracked channels pay nothing
    // per call.
    const onSuccess = def.tracksProjectUsage ? opts.onUsageTracked : undefined;
    const handler = (
      handlers as unknown as Record<
        string,
        (i: unknown, ctx: HandlerContext) => unknown
      >
    )[key];
    server.handle(def.channel, async (ctx, raw) => {
      // Input parsing is UNCONDITIONAL, never gated by build type. The
      // moment handlers are reachable over a socket, this parse is the
      // wall between a malformed payload and git argv.
      const input = def.input.parse(raw);
      const result = await handler(input, ctx);
      onSuccess?.(input);
      return opts.validateOutputs ? def.output.parse(result) : result;
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
): { channel: string; parsed: unknown } {
  const def: CallDef | undefined = module.calls[key];
  // The key type narrows to broadcast defs, but a cast at a call site
  // can defeat it. Without this guard a wrong key surfaces as a crash
  // on a missing payload schema instead of a named error.
  if (def?.kind !== "broadcast") {
    throw new Error(`contract key "${key}" is not a broadcast`);
  }
  return { channel: def.channel, parsed: def.payload.parse(payload) };
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
  const { channel, parsed } = resolveBroadcast(module, key, payload);
  server.broadcastAll(channel, parsed);
}
