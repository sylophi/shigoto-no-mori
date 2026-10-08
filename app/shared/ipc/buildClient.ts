import {
  type ContractModule,
  callsOf,
  channelOf,
  isBroadcast,
} from "@shigomori/contracts/contract";
import type { ClientTransport } from "@shared/ipc/transport";
import type { Client } from "@shigomori/contracts/types";

export function buildClient<M extends ContractModule>(
  module: M,
  transport: ClientTransport,
): Client<M> {
  const out: Record<string, unknown> = {};
  for (const [key, call] of callsOf(module)) {
    const channel = channelOf(call);
    out[key] = isBroadcast(call)
      ? (handler: (p: unknown) => void) => transport.subscribe(channel, handler)
      : (input: unknown) => transport.invoke(channel, input);
  }
  return out as Client<M>;
}
