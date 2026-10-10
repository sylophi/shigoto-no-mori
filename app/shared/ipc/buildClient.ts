import {
  type ContractCall,
  type ContractModule,
  callsOf,
  channelOf,
  isBroadcast,
  isInvoke,
  keyOf,
  outputOf,
  payloadOf,
} from "@shigomori/contracts/contract";
import { safeDecode } from "@shigomori/contracts/codec";
import type { ClientTransport } from "@shared/ipc/transport";
import type { Client, ViewObserver } from "@shigomori/contracts/types";
import { log } from "@shared/log";

// A view not started yet stops nothing.
const noop = (): void => {};

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
    } else if (isInvoke(call)) {
      out[key] = invoker(call, transport);
    } else {
      out[key] = watcher(call, transport);
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

// A view's values are decoded as a push's are, and one that does not
// decode ends the view, naming it.
function watcher(call: ContractCall, transport: ClientTransport) {
  const channel = channelOf(call);
  const payload = payloadOf(call);
  return (input: unknown, observer: ViewObserver<unknown>) => {
    if (transport.watch === undefined) {
      observer.end(new Error(`${channel} is not served on this wire`));
      return () => {};
    }
    if (transport.local === true) {
      return transport.watch(channel, input, observer);
    }
    let stop = noop;
    let ended = false;
    const end = (failure?: unknown) => {
      if (ended) return;
      ended = true;
      observer.end(failure);
    };
    stop = transport.watch(channel, input, {
      value: (raw) => {
        if (ended) return;
        const decoded = safeDecode(payload, raw);
        if (decoded.success) {
          observer.value(decoded.data);
          return;
        }
        stop();
        end(
          new Error(
            `${channel} sent a value this build does not read: ${decoded.error.message}`,
          ),
        );
      },
      end,
    });
    return () => {
      ended = true;
      stop();
    };
  };
}
