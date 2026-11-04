// The moves waiting on another device: a transplant or a mirror asked
// for while that device was offline (a send's destination, a pull's
// source). Each runs once the device comes to take this device's calls
// (PeerReach's admissions), or at once when it already does, on the
// host's own services and with no caller (queuedRun.ts), so it runs with
// every window closed. What became of it stays listed until a window
// clears it: the copy it made, or why it failed, which a retry queues
// again. One per source worktree, and held while the app runs: a quit
// drops them, and counts them first (session:busy).
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  queuedMoveKey,
  type SyncMoveRef,
  type SyncQueuedMove,
  type SyncQueueMovePayload,
} from "@shigomori/contracts/modules/sync";
import { messageOf } from "@shigomori/engine/errorDocument";
import { PeerReach } from "@host/ipc/PeerReach";
import * as Scripts from "@host/lib/Scripts";
import * as Views from "@host/lib/Views";
import type { HostServices } from "@host/process/services";
import { runQueued } from "./queuedRun";

// What a run reaches: the host's services, all of them below this one.
type RunServices = Exclude<HostServices, MoveQueue>;

export class MoveQueue extends Context.Service<
  MoveQueue,
  {
    // Replaces the source's earlier move, a running one interrupted.
    readonly queue: (move: SyncQueueMovePayload) => Effect.Effect<void>;
    readonly drop: (ref: SyncMoveRef) => Effect.Effect<void>;
    readonly watch: Stream.Stream<
      readonly SyncQueuedMove[],
      unknown,
      Views.Services
    >;
    // The ones a quit would lose: waiting or running.
    readonly pending: Effect.Effect<number>;
  }
>()("sm/host/MoveQueue") {}

const make = Effect.gen(function* () {
  const reach = yield* PeerReach;
  const services = yield* Effect.context<RunServices>();
  const held = yield* SubscriptionRef.make<ReadonlyMap<string, SyncQueuedMove>>(
    new Map(),
  );
  const running = yield* FiberMap.make<string>();
  // One change of the queue at a time: an admission, a queue and a
  // drop never interleave, so a drop always has the last word.
  const lock = yield* Semaphore.make(1);

  const settle = (key: string, state: SyncQueuedMove["state"]) =>
    SubscriptionRef.update(held, (moves) => {
      const move = moves.get(key);
      if (move === undefined) return moves;
      return new Map(moves).set(key, { ...move, state });
    });

  // Under the lock.
  const start = Effect.fnUntraced(function* (key: string) {
    const move = (yield* SubscriptionRef.get(held)).get(key);
    if (move?.state.status !== "waiting") return;
    yield* settle(key, { status: "running" });
    // A drop interrupts it, and takes the entry with it.
    yield* FiberMap.run(
      running,
      key,
      runQueued(move).pipe(
        Effect.provideContext(services),
        Effect.matchCauseEffect({
          onSuccess: (outcome) => settle(key, { status: "done", ...outcome }),
          onFailure: (cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : settle(key, {
                  status: "failed",
                  error: messageOf(Cause.squash(cause)),
                }),
        }),
      ),
    );
  });

  yield* reach.admissions.pipe(
    Stream.runForEach((deviceId) =>
      Effect.flatMap(SubscriptionRef.get(held), (moves) =>
        Effect.forEach(
          [...moves].filter(([, move]) => move.deviceId === deviceId),
          ([key]) => start(key),
          { discard: true },
        ),
      ).pipe(lock.withPermit),
    ),
    Effect.forkScoped,
  );

  const queue = Effect.fn("MoveQueue.queue")(function* (
    move: SyncQueueMovePayload,
  ) {
    const key = queuedMoveKey(move);
    yield* FiberMap.remove(running, key);
    yield* SubscriptionRef.update(held, (moves) =>
      new Map(moves).set(key, { ...move, state: { status: "waiting" } }),
    );
    if (reach.admits(move.deviceId)) yield* start(key);
  }, lock.withPermit);

  const drop = Effect.fn("MoveQueue.drop")(function* (ref: SyncMoveRef) {
    const key = queuedMoveKey(ref);
    yield* SubscriptionRef.update(held, (moves) => {
      const next = new Map(moves);
      next.delete(key);
      return next;
    });
    yield* FiberMap.remove(running, key);
  }, lock.withPermit);

  const list = Effect.map(SubscriptionRef.get(held), (moves) => [
    ...moves.values(),
  ]);

  return MoveQueue.of({
    queue,
    drop,
    watch: Views.view(
      "sync:queued",
      () => list,
      () => false,
      {
        also: Effect.succeed(SubscriptionRef.changes(held)),
      },
    ),
    pending: Effect.map(
      list,
      (moves) =>
        moves.filter(
          (move) =>
            move.state.status === "waiting" || move.state.status === "running",
        ).length,
    ),
  });
});

export const layer = Layer.effect(MoveQueue, make);

// What a quit, an update or a peer's data-folder move would interrupt:
// the work under way, and the queued moves not done yet, which it drops.
export const hostBusy = Effect.all([
  Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy),
  Effect.flatMap(MoveQueue, (queue) => queue.pending),
]).pipe(
  Effect.map(([busy, queuedMoves]) => Object.assign({}, busy, { queuedMoves })),
);
