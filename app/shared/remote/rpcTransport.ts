// A Link over an RpcClient (rpcLink), and the Promise face over any
// Link (linkTransport): what a connection hands the contract clients
// (effectClient) once it is open, for the device link (deviceLink.ts),
// the loopback (hostLink.ts) and the desktop window's link to its shell
// (portLink.ts) alike. Every push the group serves is subscribed to as
// the link is made, and fanned out here by channel.
import {
  channelOf,
  type ContractCall,
  isPush,
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
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import type { ClientTransport, Link } from "@shared/ipc/transport";
import { log } from "@shared/log";
import type { FlatClient } from "@shigomori/engine/rpcClient";

// The link dropped while calls were in flight, or a call came after it
// did: a disconnect, distinct from the handler's own failure. `local`
// for a link to this machine's own app (its host on the loopback, its
// shell over a port), which only that process going drops: the host's
// restart, in practice.
export class RemoteDisconnectedError extends Error {
  readonly local: boolean;
  constructor(local = false) {
    super(
      local
        ? "lost the connection to the app's background process"
        : "remote device disconnected",
    );
    this.name = "RemoteDisconnectedError";
    this.local = local;
  }
}

// A call cut by this machine's own app going away under it.
export const isOwnAppDrop = (error: unknown): boolean =>
  error instanceof RemoteDisconnectedError && error.local;

// Calls a link has out at once, so a page's burst of calls waits here
// for its turn rather than start a git or CLI process each on the host.
// Streams (pushes, views) hold no place, and neither do a byte
// channel's numbered calls, which go on the client beside the link
// (deviceLink.ts).
export const LINK_CALLS_IN_FLIGHT = 48;

// Lets `permits` effects run at once and the rest wait, admitted in the
// order they came. Not a Semaphore: a released permit there goes to
// whoever asks first, so a new call can pass the ones already waiting.
function fifoGate(permits: number) {
  type Ticket = { granted: boolean; wake?: () => void };
  let active = 0;
  // A Set iterates in insertion order: the first is the longest waiting.
  const waiting = new Set<Ticket>();
  // A finished effect's place passes straight to the first waiting.
  const release = () => {
    const next = waiting.values().next();
    if (next.done === true) {
      active -= 1;
      return;
    }
    waiting.delete(next.value);
    next.value.granted = true;
    next.value.wake?.();
  };
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const ran = restore(effect).pipe(Effect.ensuring(Effect.sync(release)));
        if (active < permits) {
          active += 1;
          return ran;
        }
        const ticket: Ticket = { granted: false };
        waiting.add(ticket);
        const turn = Effect.callback<void>((resume) => {
          if (ticket.granted) resume(Effect.void);
          else ticket.wake = () => resume(Effect.void);
        });
        // Interrupted while waiting, it leaves the line, or passes on
        // the place it was just given.
        return restore(turn).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (ticket.granted) release();
              else waiting.delete(ticket);
            }),
          ),
          Effect.andThen(ran),
        );
      }),
    );
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
  // The far end is this machine's own app, which its drops name.
  readonly local?: boolean;
}): Effect.fn.Return<Link, never, Scope.Scope> {
  const { client, group } = options;
  const local = options.local === true;
  const dropped = droppedOn(local);
  const fanOut = pushFanOut();
  const gated = fifoGate(LINK_CALLS_IN_FLIGHT);
  for (const call of group.requests.values()) {
    if (!isPush(call)) continue;
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
      const called = Effect.suspend(() =>
        (
          client(
            channel,
            decode(rpc.payloadSchema as ContractSchema, input),
          ) as Effect.Effect<unknown, unknown>
        ).pipe(
          Effect.catchDefect((defect) => {
            const error = dropped(defect);
            return error === undefined
              ? Effect.die(defect)
              : Effect.fail(error);
          }),
        ),
      ).pipe(Effect.mapError(failureOn(local)), gated);
      return span === undefined ? called : Effect.withParentSpan(called, span);
    },
    view: (channel, input) => {
      const rpc = group.requests.get(channel);
      if (rpc === undefined || isInvoke(rpc) || isPush(rpc)) {
        return Stream.die(
          new Error(`No view registered for channel "${channel}"`),
        );
      }
      return Stream.suspend(() =>
        (
          client(
            channel,
            decode(rpc.payloadSchema as ContractSchema, input),
          ) as Stream.Stream<unknown, unknown>
        ).pipe(
          Stream.catchDefect((defect) => {
            const error = dropped(defect);
            return error === undefined
              ? Stream.die(defect)
              : Stream.fail(error);
          }),
        ),
      ).pipe(Stream.mapError(failureOn(local)));
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
          // Interrupted with no abort, the call went with its link's
          // scope, as a view does.
          else if (
            Cause.hasInterruptsOnly(exit.cause) &&
            signal?.aborted !== true
          ) {
            reject(new RemoteDisconnectedError(link.local === true));
          } else reject(rejectionOf(exit.cause));
        });
      }),
    watch(channel, input, observer) {
      let stopped = false;
      const fiber = runFork(
        Stream.runForEach(link.view(channel, input), (value) =>
          Effect.sync(() => observer.value(value)),
        ),
      );
      // Interrupted with no stop, the view went with its link's scope.
      fiber.addObserver((exit) => {
        if (stopped) return;
        observer.end(
          Exit.isSuccess(exit)
            ? undefined
            : Cause.hasInterruptsOnly(exit.cause)
              ? new RemoteDisconnectedError(link.local === true)
              : Cause.squash(exit.cause),
        );
      });
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

// A request the socket couldn't write: the link going under it, which
// the transport raises as a defect.
const droppedOn = (local: boolean) => (defect: unknown) =>
  Socket.isSocketError(defect) ? new RemoteDisconnectedError(local) : undefined;

// A call's failure as its caller sees it: the contract error it was
// sent as (RemoteCallError for a plain one, carrying its message and
// code), or the link gone.
const failureOn =
  (local: boolean) =>
  (error: unknown): unknown => {
    if (isContractError(error) || isRemoteCallError(error)) return error;
    if (Predicate.isTagged(error, "RpcClientError")) {
      return new RemoteDisconnectedError(local);
    }
    return error instanceof Error ? error : new Error(String(error));
  };

function rejectionOf(cause: Cause.Cause<unknown>): unknown {
  if (Cause.hasInterruptsOnly(cause)) {
    return new Error("the call was cancelled");
  }
  return Cause.squash(cause);
}
