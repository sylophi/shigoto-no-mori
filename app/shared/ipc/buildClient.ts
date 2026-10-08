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
import { safeDecode } from "@shigomori/contracts/codec";
import type { ClientTransport } from "@shared/ipc/transport";
import type { Client } from "@shigomori/contracts/types";
import { log } from "@shared/log";

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

// A result over any but a local transport is decoded with the call's
// output schema, the same decode the server runs on its inputs: a peer
// on another build, or a handler that drifted, rejects the call here,
// naming it, instead of handing the caller a shape its types do not
// describe.
function invoker(call: ContractCall, transport: ClientTransport) {
  const channel = channelOf(call);
  if (transport.local === true) {
    return (input: unknown) => transport.invoke(channel, input);
  }
  const output = outputOf(call);
  return async (input: unknown) => {
    const decoded = safeDecode(output, await transport.invoke(channel, input));
    if (!decoded.success) {
      throw new Error(
        `${channel} answered in a shape this build does not read: ${decoded.error.message}`,
      );
    }
    return decoded.data;
  };
}

// A push that does not decode is dropped, there being no caller to
// reject, and logged so the drift shows.
function subscriber(call: ContractCall, transport: ClientTransport) {
  const channel = channelOf(call);
  if (transport.local === true) {
    return (handler: (payload: unknown) => void) =>
      transport.subscribe(channel, handler);
  }
  const payload = payloadOf(call);
  return (handler: (payload: unknown) => void) =>
    transport.subscribe(channel, (raw) => {
      const decoded = safeDecode(payload, raw);
      if (decoded.success) handler(decoded.data);
      else
        log.warn(
          `[contracts] dropped a ${channel} push this build does not read: ${decoded.error.message}`,
        );
    });
}
