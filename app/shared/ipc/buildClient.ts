import {
  type ContractModule,
  callsOf,
  channelOf,
  isBroadcast,
  keyOf,
} from "@shigomori/contracts/contract";
import type { ClientTransport } from "@shared/ipc/transport";
import type { Client } from "@shigomori/contracts/types";

export function buildClient<M extends ContractModule>(
  module: M,
  transport: ClientTransport,
): Client<M> {
  const out: Record<string, unknown> = {};
  for (const call of callsOf(module)) {
    const channel = channelOf(call);
    const key = keyOf(call);
    if (isBroadcast(call)) {
      out[`on${key.charAt(0).toUpperCase()}${key.slice(1)}`] = (
        handler: (p: unknown) => void,
      ) => transport.subscribe(channel, handler);
    } else {
      out[key] = (input: unknown) => transport.invoke(channel, input);
    }
  }
  return out as Client<M>;
}
