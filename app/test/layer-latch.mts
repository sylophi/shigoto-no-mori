// Proof for the latch a layer hands code outside the graph
// (host/lib/util/layerLatch.ts): a read before the layer is up waits
// for it and gets what it built, a layer that failed to start refuses
// the read with why, and a read after the layer closed is refused.
//
// Run: pnpm test layer-latch.
import assert from "node:assert/strict";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { it } from "vitest";
import { LayerDownError, layerLatch } from "../host/lib/util/layerLatch.ts";

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof LayerDownError;

it("a read before the layer is up waits for it, and one after its close is refused", async () => {
  const latch = layerLatch<string>("The thing");
  await Effect.runPromise(
    Effect.gen(function* () {
      const early = yield* Effect.forkChild(latch.get);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        Layer.effectDiscard(latch.provide(Effect.succeed("built"))),
        scope,
      );
      assert.equal(yield* Fiber.join(early), "built");
      assert.equal(latch.now(), "built");
      yield* Scope.close(scope, Exit.void);
      assert.equal(latch.now(), undefined);
      assert.ok(refusal(yield* Effect.exit(latch.get)));
    }),
  );
});

it("a layer that failed to start refuses the reads that waited on it", async () => {
  const latch = layerLatch<string>("The thing");
  await Effect.runPromise(
    Effect.gen(function* () {
      const early = yield* Effect.forkChild(Effect.exit(latch.get));
      const scope = yield* Scope.make();
      yield* Effect.exit(
        Layer.buildWithScope(
          Layer.effectDiscard(latch.provide(Effect.fail("no daemon"))),
          scope,
        ),
      );
      const exit = yield* Fiber.join(early);
      assert.ok(refusal(exit));
      assert.match(String(Exit.isFailure(exit) && exit.cause), /no daemon/);
    }),
  );
});
