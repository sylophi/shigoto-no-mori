import {
  type ContractCall,
  type ContractModule,
  callsOf,
  channelOf,
  isBroadcast,
  keyOf,
  outputOf,
  payloadOf,
} from "@shigomori/contracts/contract";
import { decode, safeDecode } from "@shigomori/contracts/codec";
import type { ClientTransport } from "@shared/ipc/transport";
import type { Client } from "@shigomori/contracts/types";

export function buildClient<M extends ContractModule>(
  module: M,
  transport: ClientTransport,
): Client<M> {
  const out: Record<string, unknown> = {};
  for (const call of callsOf(module)) {
    const key = keyOf(call);
    if (isBroadcast(call)) {
      out[`on${key.charAt(0).toUpperCase()}${key.slice(1)}`] = subscriber(
        call,
        transport,
      );
    } else {
      out[key] = invoker(call, transport);
    }
  }
  return out as Client<M>;
}

// A remote result is decoded with the call's output schema, the same
// decode the server runs on its inputs: a peer on another build, or a
// handler that drifted, rejects the call here instead of handing the
// caller a shape its types do not describe.
function invoker(call: ContractCall, transport: ClientTransport) {
  const channel = channelOf(call);
  if (transport.remote !== true) {
    return (input: unknown) => transport.invoke(channel, input);
  }
  const output = outputOf(call);
  return async (input: unknown) =>
    decode(output, await transport.invoke(channel, input));
}

// A remote push that does not decode is dropped: there is no caller to
// reject, and the next one replaces it.
function subscriber(call: ContractCall, transport: ClientTransport) {
  const channel = channelOf(call);
  if (transport.remote !== true) {
    return (handler: (payload: unknown) => void) =>
      transport.subscribe(channel, handler);
  }
  const payload = payloadOf(call);
  return (handler: (payload: unknown) => void) =>
    transport.subscribe(channel, (raw) => {
      const decoded = safeDecode(payload, raw);
      if (decoded.success) handler(decoded.data);
    });
}
