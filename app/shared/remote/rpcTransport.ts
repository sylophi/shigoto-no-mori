// A Link over an RpcClient (rpcLink), and the Promise face over any
// Link (linkTransport): what a connection hands the contract clients
// (buildClient) once it is open, for the device link (deviceLink.ts),
// the loopback (hostLink.ts) and the desktop window's link to its shell
// (portLink.ts) alike. Every push the group serves is subscribed to as
// the link is made, and fanned out here by channel.
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
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ClientTransport, Link } from "@shared/ipc/transport";
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

// Handlers by channel, which a link's pushes fan out to. A stream over
// one channel's pushes holds a handler for as long as it runs.
export type PushFanOut = {
  readonly emit: (channel: string, payload: unknown) => void;
  readonly pushes: (channel: string) => Stream.Stream<unknown>;
};

export function pushFanOut(): PushFanOut {
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit(channel, payload) {
      for (const handler of subscribers.get(channel) ?? []) handler(payload);
    },
    pushes: (channel) =>
      Stream.callback<unknown>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const handler = (payload: unknown) => {
              Queue.offerUnsafe(queue, payload);
            };
            let handlers = subscribers.get(channel);
            if (handlers === undefined) {
              handlers = new Set();
              subscribers.set(channel, handlers);
            }
            handlers.add(handler);
            return handler;
          }),
          (handler) =>
            Effect.sync(() => subscribers.get(channel)?.delete(handler)),
        ),
      ),
  };
}

export const rpcLink = Effect.fnUntraced(function* (options: {
  readonly client: FlatClient;
  readonly group: RpcGroup.Any & {
    readonly requests: ReadonlyMap<string, ContractCall>;
  };
  // Every push, before its subscribers hear it.
  readonly onPush?: (channel: string, payload: unknown) => void;
}): Effect.fn.Return<Link, never, Scope.Scope> {
  const { client, group } = options;
  const fanOut = pushFanOut();
  for (const call of group.requests.values()) {
    if (!isBroadcast(call)) continue;
    const channel = channelOf(call);
    yield* Stream.runForEach(
      client(channel, undefined) as Stream.Stream<unknown, unknown>,
      (payload) =>
        Effect.sync(() => {
          options.onPush?.(channel, payload);
          fanOut.emit(channel, payload);
        }),
    ).pipe(Effect.ignore, Effect.forkScoped({ startImmediately: true }));
  }
  return {
    call: (channel, input, span) => {
      const rpc = group.requests.get(channel);
      if (rpc === undefined || !isInvoke(rpc)) {
        return Effect.die(
          new Error(`No handler registered for channel "${channel}"`),
        );
      }
      const called = Effect.suspend(
        () =>
          client(
            channel,
            decode(rpc.payloadSchema as ContractSchema, input),
          ) as Effect.Effect<unknown, unknown>,
      ).pipe(Effect.mapError(failureOf));
      return span === undefined ? called : Effect.withParentSpan(called, span);
    },
    view: (channel, input) => {
      const rpc = group.requests.get(channel);
      if (rpc === undefined || isInvoke(rpc) || isBroadcast(rpc)) {
        return Stream.die(
          new Error(`No view registered for channel "${channel}"`),
        );
      }
      return Stream.suspend(
        () =>
          client(
            channel,
            decode(rpc.payloadSchema as ContractSchema, input),
          ) as Stream.Stream<unknown, unknown>,
      ).pipe(Stream.mapError(failureOf));
    },
    pushes: fanOut.pushes,
  };
});

// The Promise face over a Link, its calls, views and pushes run with
// `runFork`: the runtime of the scope the link lives in.
export function linkTransport(
  link: Link,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>,
): ClientTransport {
  return {
    local: link.local,
    invoke: (channel, input, invokeOptions) =>
      new Promise((resolve, reject) => {
        const fiber = runFork(link.call(channel, input, invokeOptions?.span));
        const signal = invokeOptions?.signal;
        const abort = () => runFork(Fiber.interrupt(fiber));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted === true) abort();
        fiber.addObserver((exit) => {
          signal?.removeEventListener("abort", abort);
          if (Exit.isSuccess(exit)) resolve(exit.value);
          else reject(rejectionOf(exit.cause));
        });
      }),
    watch(channel, input, observer) {
      let stopped = false;
      const fiber = runFork(
        link.view(channel, input).pipe(
          Stream.runForEach((value) =>
            Effect.sync(() => observer.value(value)),
          ),
          Effect.exit,
          Effect.map((exit) => {
            if (stopped) return;
            observer.end(
              Exit.isSuccess(exit) ? undefined : rejectionOf(exit.cause),
            );
          }),
        ),
      );
      return () => {
        stopped = true;
        runFork(Fiber.interrupt(fiber));
      };
    },
    subscribe(channel, handler) {
      const fiber = runFork(
        Stream.runForEach(link.pushes(channel), (payload) =>
          Effect.sync(() => {
            try {
              handler(payload);
            } catch (error) {
              log.warn(
                `[link] a ${channel} subscriber threw: ${errorMessageOf(error)}`,
              );
            }
          }),
        ),
      );
      return () => {
        runFork(Fiber.interrupt(fiber));
      };
    },
  };
}

// A call's failure as its caller sees it: the contract error it was
// sent as (RemoteCallError for a plain one, carrying its message and
// code), or the link gone.
function failureOf(error: unknown): unknown {
  if (isContractError(error) || isRemoteCallError(error)) return error;
  if (Predicate.isTagged(error, "RpcClientError")) {
    return new RemoteDisconnectedError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

function rejectionOf(cause: Cause.Cause<unknown>): unknown {
  if (Cause.hasInterruptsOnly(cause)) {
    return new Error("the call was cancelled");
  }
  return Cause.squash(cause);
}
