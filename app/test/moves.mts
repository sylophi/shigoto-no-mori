// Proof for the moves in flight (host/lib/sync/Moves.ts): a move runs on
// a fiber of its own under its key, a second by the same key is refused
// while it runs, a cancel by key interrupts it (its finalizers run) and
// fails its call with the cancel, the caller's call interrupted
// interrupts it too, and a key is the caller's: another device's move
// of the same worktree is its own. Over the device link, a peer's move
// cancelled by key reaches the caller as the same quiet outcome as
// ever: the cancelled marker the dialogs read as their cancelled step
// (isMoveCancelledError), never an interruption or a failure. The real
// moves' unwinding is sync-transfer.mts's.
//
// Run: pnpm test moves.
import assert from "node:assert/strict";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { HandlerContext } from "@shared/ipc/transport";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { it } from "vitest";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import {
  isMoveCancelledError,
  MOVE_CANCELLED,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import { buildClient } from "@shared/ipc/buildClient";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { syncHandlers } from "@host/ipc/modules/sync";
import * as Moves from "../host/lib/sync/Moves.ts";
import { bootDirectWire } from "./lib/directBoot.mts";
import { trackTest } from "./lib/vitestKit.mts";

const run = <A, E>(effect: Effect.Effect<A, E, Moves.Moves>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, Moves.layer)));

const here = {};
const peer = { callerDeviceId: "peer" };

// A move that runs until it is cut short, saying when it started and
// when its finalizer ran.
const hanging = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const unwound = yield* Deferred.make<void>();
  const move = Effect.andThen(
    Deferred.succeed(started, undefined),
    Effect.never,
  ).pipe(Effect.ensuring(Deferred.succeed(unwound, undefined)));
  return { started, unwound, move };
});

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

it("a second move by the same key is refused, a cancel by key fails the first with the cancel, and then there is nothing to cancel", async () => {
  await run(
    Effect.gen(function* () {
      const moves = yield* Moves.Moves;
      const first = yield* hanging;
      const call = yield* Effect.forkChild(
        Effect.exit(moves.run(here, "wt", first.move)),
      );
      yield* Deferred.await(first.started);
      const second = yield* Effect.exit(moves.run(here, "wt", Effect.void));
      assert.match(String(failure(second)), /already being moved/);
      // Another device's move of the same worktree is not this one.
      assert.equal(yield* moves.run(peer, "wt", Effect.succeed(1)), 1);
      assert.equal(yield* moves.cancel(peer, "wt"), false);
      assert.equal(yield* moves.cancel(here, "wt"), true);
      const exit = yield* Fiber.join(call);
      assert.ok(failure(exit) instanceof Moves.MoveCancelledError);
      assert.equal((failure(exit) as Error).message, MOVE_CANCELLED);
      assert.ok(yield* Deferred.isDone(first.unwound));
      assert.equal(yield* moves.cancel(here, "wt"), false);
      // The key is free again.
      assert.equal(yield* moves.run(here, "wt", Effect.succeed(2)), 2);
    }),
  );
});

it("a call interrupted interrupts its move, unwound by the time the interrupt returns", async () => {
  await run(
    Effect.gen(function* () {
      const moves = yield* Moves.Moves;
      const move = yield* hanging;
      const call = yield* Effect.forkChild(moves.run(here, "wt", move.move));
      yield* Deferred.await(move.started);
      yield* Fiber.interrupt(call);
      assert.ok(yield* Deferred.isDone(move.unwound));
      assert.equal(yield* moves.cancel(here, "wt"), false);
    }),
  );
});

it("a move's own failure is its call's, and the key is freed", async () => {
  await run(
    Effect.gen(function* () {
      const moves = yield* Moves.Moves;
      const exit = yield* Effect.exit(
        moves.run(here, "wt", Effect.fail("no peer")),
      );
      assert.equal(failure(exit), "no peer");
      assert.equal(yield* moves.run(here, "wt", Effect.succeed(3)), 3);
    }),
  );
});

it("over the device link: a peer's move cancelled by key fails its call with the cancelled marker the dialogs read as cancelled, and a second cancel finds nothing", async () => {
  const started = Deferred.makeUnsafe<void>();
  const { listener, toListener } = await bootDirectWire(trackTest, {
    contracts: [
      // The original's device runs a mirror start for the copy's: here
      // a move that runs until it is cut short.
      [
        mirrorContract,
        {
          ...mirrorHandlers,
          startTo: (
            input: Parameters<typeof mirrorHandlers.startTo>[0],
            ctx: HandlerContext,
          ) =>
            Effect.flatMap(Moves.Moves, (moves) =>
              moves.run(
                ctx,
                input.worktreeId,
                Effect.andThen(
                  Deferred.succeed(started, undefined),
                  Effect.never,
                ),
              ),
            ),
        },
      ],
      [syncContract, syncHandlers],
    ],
  });
  listener.setAccepts(true);
  const mirror = buildClient(mirrorContract, toListener.transport);
  const sync = buildClient(syncContract, toListener.transport);
  const start = mirror
    .startTo({
      targetDeviceId: "copy-device",
      projectId: "p",
      worktreeId: "0123456789ab",
      ignoreMode: "gitignored",
      ignores: [],
    })
    .then(
      () => assert.fail("a cancelled move answered"),
      (error: unknown) => error,
    );
  await Effect.runPromise(Deferred.await(started));
  assert.deepEqual(
    await sync.cancelMove({ sourceWorktreeId: "0123456789ab" }),
    { cancelled: true },
  );
  const error = await start;
  assert.ok(isMoveCancelledError(error), String(error));
  assert.deepEqual(
    await sync.cancelMove({ sourceWorktreeId: "0123456789ab" }),
    { cancelled: false },
  );
});
