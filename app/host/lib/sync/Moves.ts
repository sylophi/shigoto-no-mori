// The moves in flight on this host, so one can be cancelled: a pull or
// a send this device runs, or a mirror start (a send with a session on
// top). Each runs on a fiber of its own, keyed the way the caller keys
// its progress: by the source worktree id, scoped to the calling peer,
// so a cancel finds exactly the move its caller asked for and never
// another device's. A landing this host runs for a peer's send is not
// here: its cancel is the link the sender tears down (landing.ts,
// landForSender), so it needs no key of its own.
//
// The call that started a move waits on its fiber, and interrupting
// the call (a window that reloads, a peer whose socket dies) interrupts
// the move, so nothing keeps landing for a caller that is gone. What a
// step made is undone by its finalizer (the created worktree removed,
// the link reset), and a move cancelled by key fails its call with
// MOVE_CANCELLED. Per key rather than per call because a cancel can
// come from outside the call: the terminal's verb or a peer's mirror
// asks for it by key (sync:cancelMove).
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { MOVE_CANCELLED } from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";

export class MoveCancelledError extends Schema.TaggedError<MoveCancelledError>()(
  "MoveCancelledError",
  {},
) {
  override get message(): string {
    return MOVE_CANCELLED;
  }
}

class MoveBusyError extends Schema.TaggedError<MoveBusyError>()(
  "MoveBusyError",
  {},
) {
  override get message(): string {
    return "That worktree is already being moved. Wait for it.";
  }
}

// Who asked: the peer, or this machine's own caller.
type Caller = Pick<HandlerContext, "callerDeviceId">;

export class Moves extends Context.Service<
  Moves,
  {
    // Runs a move on its own fiber, registered for its length. One move
    // per key at a time: the dialogs run one mutation per worktree, and
    // a second by the same key while one runs is a bug worth refusing
    // over, not a cancel of the first.
    readonly run: <A, E, R>(
      caller: Caller,
      sourceWorktreeId: string,
      move: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | MoveBusyError | MoveCancelledError, R>;
    // Interrupts the move the caller has in flight by that key, without
    // waiting for it to unwind. False when there is none: it finished,
    // or never reached this host.
    readonly cancel: (
      caller: Caller,
      sourceWorktreeId: string,
    ) => Effect.Effect<boolean>;
  }
>()("sm/host/Moves") {}

const keyOf = (caller: Caller, sourceWorktreeId: string) =>
  `${caller.callerDeviceId ?? ""}:${sourceWorktreeId}`;

const make = Effect.gen(function* () {
  // Closed with the graph, which interrupts whatever is still moving.
  const moves = yield* FiberMap.make<string>();
  const scope = yield* Effect.scope;
  const admission = yield* Semaphore.make(1);

  const run = <A, E, R>(
    caller: Caller,
    sourceWorktreeId: string,
    move: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | MoveBusyError | MoveCancelledError, R> => {
    const key = keyOf(caller, sourceWorktreeId);
    // Only the wait is interruptible, so a move once started always has
    // its call's interrupt to follow.
    return Effect.uninterruptibleMask((restore) =>
      admission
        .withPermit(
          Effect.suspend(() =>
            FiberMap.hasUnsafe(moves, key)
              ? Effect.fail(new MoveBusyError())
              : FiberMap.run(moves, key, move),
          ),
        )
        .pipe(
          Effect.flatMap((fiber) =>
            restore(Fiber.await(fiber)).pipe(
              Effect.onInterrupt(() => Fiber.interrupt(fiber)),
            ),
          ),
        ),
    ).pipe(
      // Interrupted by a cancel: the move fails with it, whatever the
      // step it was on said as it was cut short.
      Effect.flatMap(
        (exit): Effect.Effect<A, E | MoveCancelledError> =>
          Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
            ? Effect.fail(new MoveCancelledError())
            : exit,
      ),
    );
  };

  const cancel = Effect.fn("Moves.cancel")(function* (
    caller: Caller,
    sourceWorktreeId: string,
  ) {
    const fiber = FiberMap.getUnsafe(moves, keyOf(caller, sourceWorktreeId));
    if (Option.isNone(fiber)) return false;
    yield* Effect.forkIn(Fiber.interrupt(fiber.value), scope);
    return true;
  });

  return Moves.of({ run, cancel });
});

export const layer = Layer.effect(Moves, make);
