// A module's invokes as effects over a link (shared/ipc/transport.ts
// Link): each the link's RPC client's own call, which decodes the
// answer with the call's output schema.
import {
  type ContractModule,
  callsOf,
  channelOf,
  isInvoke,
  keyOf,
} from "@shigomori/contracts/contract";
import type { EffectClient } from "@shigomori/contracts/types";
import type { Link } from "./transport";

export function effectClient<M extends ContractModule>(
  module: M,
  link: Pick<Link, "call">,
): EffectClient<M> {
  const calls: Record<string, (input?: unknown) => unknown> = {};
  for (const call of callsOf(module)) {
    if (!isInvoke(call)) continue;
    const channel = channelOf(call);
    calls[keyOf(call)] = (input) => link.call(channel, input);
  }
  // oxlint-disable-next-line shigomori/no-double-cast -- built from the module's own calls, each answering as its call
  return calls as unknown as EffectClient<M>;
}
