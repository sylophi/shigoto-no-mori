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
//
// What runs past the call that started it is held here too (`fork`):
// a source's serving of a peer's link, a send's wait on the peer's
// answer, and the undo of an answer that came after a cancel. So is
// what each finished move recorded for its teardown (receipts.ts).
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  MOVE_CANCELLED,
  type SyncMoveRef,
  type SyncReceipt,
} from "@shigomori/contracts/modules/sync";
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
    // Runs work that outlives the call that started it, until it ends
    // or the graph closes.
    readonly fork: <A, E, R>(
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>;
    // A peer's bringing from here, served until it ends or the graph
    // closes, counted under that peer.
    readonly serve: <A, E, R>(
      peerDeviceId: string,
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>;
    // What a data-folder move's copy would miss: a move in flight here
    // (from before its landing to its last file, or its forked work),
    // and the peers bringing from here.
    readonly underWay: Effect.Effect<MovesUnderWay>;
    readonly remember: (
      move: SyncMoveRef,
      receipt: SyncReceipt,
    ) => Effect.Effect<void>;
    readonly receiptOf: (
      move: SyncMoveRef,
    ) => Effect.Effect<SyncReceipt | undefined>;
    readonly forget: (move: SyncMoveRef) => Effect.Effect<void>;
  }
>()("sm/host/Moves") {}

export type MovesUnderWay = {
  readonly moving: boolean;
  // The ids of the peers bringing a worktree from here.
  readonly bringing: ReadonlyArray<string>;
};

const keyOf = (caller: Caller, sourceWorktreeId: string) =>
  `${caller.callerDeviceId ?? ""}:${sourceWorktreeId}`;

// What each move captured and applied, by source worktree, for the
// teardown that may follow, kept by the device that ran the move (the
// destination after a pull, the source after a send, which the
// destination's landing hands its receipt). Read by the teardown, so
// the data-loss rule runs on the hosts' own facts: a caller cannot
// claim a capture landed when it did not. The branch tip and the
// capture's tree let the teardown prove the source is still exactly
// what moved, however long the user took to decide. Ephemeral by
// design (a restart forgets, and the teardown then refuses), bounded
// so a host that moves worktrees for weeks never grows it.
const RECEIPT_LIMIT = 64;
const receiptKey = (move: SyncMoveRef) =>
  `${move.direction}:${move.deviceId}/${move.projectId}/${move.worktreeId}`;

const make = Effect.gen(function* () {
  // Closed with the graph, which interrupts whatever is still moving,
  // the moves before what they forked.
  const forked = yield* FiberSet.make();
  const moves = yield* FiberMap.make<string>();
  const receipts = yield* Ref.make(new Map<string, SyncReceipt>());
  // Each peer's serves under way, by its device id.
  const serving = yield* Ref.make(new Map<string, number>());
  const count = (peerDeviceId: string, by: number) =>
    Ref.update(serving, (counts) => {
      const next = new Map(counts);
      const now = (next.get(peerDeviceId) ?? 0) + by;
      if (now > 0) next.set(peerDeviceId, now);
      else next.delete(peerDeviceId);
      return next;
    });
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

  const remember = Effect.fn("Moves.remember")(function* (
    move: SyncMoveRef,
    receipt: SyncReceipt,
  ) {
    const key = receiptKey(move);
    yield* Ref.update(receipts, (kept) => {
      const next = new Map(kept);
      next.delete(key);
      next.set(key, receipt);
      for (const oldest of next.keys()) {
        if (next.size <= RECEIPT_LIMIT) break;
        next.delete(oldest);
      }
      return next;
    });
  });

  const receiptOf = Effect.fn("Moves.receiptOf")(function* (move: SyncMoveRef) {
    return (yield* Ref.get(receipts)).get(receiptKey(move));
  });

  const forget = Effect.fn("Moves.forget")(function* (move: SyncMoveRef) {
    yield* Ref.update(receipts, (kept) => {
      const next = new Map(kept);
      next.delete(receiptKey(move));
      return next;
    });
  });

  return Moves.of({
    // oxlint-disable-next-line shigomori/effect-fn-service-methods -- generic over the move it runs, which Effect.fn's signature would erase
    run,
    cancel,
    // oxlint-disable-next-line shigomori/effect-fn-service-methods -- generic over the work it forks, which Effect.fn's signature would erase
    fork: (work) => FiberSet.run(forked, work),
    // Counted inside its fiber, so a serve that never starts (the set
    // closed, its caller gone) is never counted.
    // oxlint-disable-next-line shigomori/effect-fn-service-methods -- generic over the work it serves, which Effect.fn's signature would erase
    serve: (peerDeviceId, work) =>
      FiberSet.run(
        forked,
        Effect.acquireUseRelease(
          count(peerDeviceId, 1),
          () => work,
          () => count(peerDeviceId, -1),
        ),
      ),
    underWay: Effect.map(
      Effect.all([
        FiberMap.size(moves),
        FiberSet.size(forked),
        Ref.get(serving),
      ]),
      ([running, rest, counts]) => {
        const served = [...counts.values()].reduce((sum, n) => sum + n, 0);
        return {
          moving: running > 0 || rest > served,
          bringing: [...counts.keys()],
        };
      },
    ),
    remember,
    receiptOf,
    forget,
  });
});

export const layer = Layer.effect(Moves, make);
