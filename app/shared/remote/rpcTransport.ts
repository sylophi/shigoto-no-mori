// A ClientTransport over an RpcClient: what a connection hands the
// contract clients (buildClient) once it is open, for the device link
// (deviceLink.ts) and the desktop window's link to its shell
// (shellLink.ts) alike. Every push the group serves is subscribed to
// as it is built, and fanned out here by channel.
import {
  channelOf,
  type ContractCall,
  isBroadcast,
  isInvoke,
} from "@shigomori/contracts/contract";
import { type ContractSchema, decode } from "@shigomori/contracts/codec";
import {
  errorMessageOf,
  isContractError,
  isRemoteCallError,
} from "@shigomori/contracts/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";
import type { ClientTransport } from "@shared/ipc/transport";
import { log } from "@shared/log";

// An RpcClient made with `flatten`, which the group's calls (built from
// the contracts as listed) type only as some call.
export type FlatClient = (
  tag: string,
  payload: unknown,
  options?: object,
) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>;

// The link dropped while calls were in flight, or a call came after it
// did: a disconnect, distinct from the handler's own failure.
class RemoteDisconnectedError extends Error {
  constructor() {
    super("remote device disconnected");
    this.name = "RemoteDisconnectedError";
  }
}

export function rpcTransport(options: {
  readonly client: FlatClient;
  readonly group: RpcGroup.Any & {
    readonly requests: ReadonlyMap<string, ContractCall>;
  };
  // Runs a fiber for as long as the connection lives.
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  // Every push, before its subscribers hear it.
  readonly onPush?: (channel: string, payload: unknown) => void;
}): ClientTransport {
  const { client, group } = options;
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  for (const call of group.requests.values()) {
    if (!isBroadcast(call)) continue;
    const channel = channelOf(call);
    options.fork(
      Stream.runForEach(
        client(channel, undefined) as Stream.Stream<unknown, unknown>,
        (payload) =>
          Effect.sync(() => {
            options.onPush?.(channel, payload);
            for (const handler of subscribers.get(channel) ?? []) {
              try {
                handler(payload);
              } catch (error) {
                log.warn(
                  `[link] a ${channel} subscriber threw: ${errorMessageOf(error)}`,
                );
              }
            }
          }),
      ).pipe(Effect.ignore),
    );
  }
  return {
    invoke(channel, input, invokeOptions) {
      const rpc = group.requests.get(channel);
      if (rpc === undefined || !isInvoke(rpc)) {
        return Promise.reject(
          new Error(`No handler registered for channel "${channel}"`),
        );
      }
      const called = Effect.suspend(
        () =>
          client(
            channel,
            decode(rpc.payloadSchema as ContractSchema, input),
          ) as Effect.Effect<unknown, unknown>,
      );
      const span = invokeOptions?.span;
      return Effect.runPromiseExit(
        span === undefined ? called : Effect.withParentSpan(called, span),
        { signal: invokeOptions?.signal },
      ).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        throw failureOf(exit.cause);
      });
    },
    subscribe(channel, handler) {
      let handlers = subscribers.get(channel);
      if (handlers === undefined) {
        handlers = new Set();
        subscribers.set(channel, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

// A call's failure as its Promise caller sees it: the contract error it
// was sent as (RemoteCallError for a plain one, carrying its message
// and code), or the link gone.
function failureOf(cause: Cause.Cause<unknown>): unknown {
  const error = Cause.squash(cause);
  if (isContractError(error) || isRemoteCallError(error)) return error;
  if (Cause.hasInterruptsOnly(cause))
    return new Error("the call was cancelled");
  if (Predicate.isTagged(error, "RpcClientError")) {
    return new RemoteDisconnectedError();
  }
  return error instanceof Error ? error : new Error(String(error));
}
