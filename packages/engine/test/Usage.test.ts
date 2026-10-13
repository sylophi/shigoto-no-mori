import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { it } from "vitest";
import * as Usage from "../src/Usage.ts";
import { freshDataDir, onStoreAt } from "./lib/nodeStore.ts";

const dataDir = freshDataDir("engine-usage-");

const run = <A>(program: Effect.Effect<A, never, Usage.Usage>) =>
  program.pipe(
    Effect.provide(
      Usage.layer.pipe(onStoreAt(dataDir()), Layer.merge(TestClock.layer())),
    ),
    Effect.runPromise,
  );

const day = 24 * 60 * 60 * 1000;

it("counts uses in the window, and the newest use whenever it was", async () => {
  const stats = await run(
    Effect.gen(function* () {
      const usage = yield* Usage.Usage;
      yield* TestClock.setTime(1 * day);
      yield* usage.record("script", "P", "dev");
      yield* TestClock.setTime(10 * day);
      yield* usage.record("script", "P", "dev");
      yield* usage.record("script", "P", "test");
      yield* usage.record("script", "Q", "dev");
      yield* TestClock.setTime(20 * day);
      return yield* usage.stats("script", "P");
    }),
  );
  assert.deepEqual(
    stats,
    new Map([
      ["dev", { lastUsed: 10 * day, recentCount: 1 }],
      ["test", { lastUsed: 10 * day, recentCount: 1 }],
    ]),
  );
});

it("drops a name's uses older than the window when it is used again", async () => {
  const stats = await run(
    Effect.gen(function* () {
      const usage = yield* Usage.Usage;
      yield* TestClock.setTime(1 * day);
      yield* usage.record("launcher", "", "app:zed");
      yield* TestClock.setTime(30 * day);
      const before = yield* usage.stats("launcher", "");
      yield* usage.record("launcher", "", "app:zed");
      return [before, yield* usage.stats("launcher", "")];
    }),
  );
  assert.deepEqual(stats, [
    new Map([["app:zed", { lastUsed: 1 * day, recentCount: 0 }]]),
    new Map([["app:zed", { lastUsed: 30 * day, recentCount: 1 }]]),
  ]);
});
