import type { ContractModule } from "@shared/ipc/contract";
import type { ClientTransport } from "@shared/ipc/transport";
import type { Client } from "@shared/ipc/types";

export function buildClient<M extends ContractModule>(
  module: M,
  transport: ClientTransport,
): Client<M> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(module.calls)) {
    if (def.kind === "invoke") {
      out[key] = (input: unknown) => transport.invoke(def.channel, input);
    } else {
      out[key] = (handler: (p: unknown) => void) =>
        transport.subscribe(def.channel, handler);
    }
  }
  return out as Client<M>;
}
