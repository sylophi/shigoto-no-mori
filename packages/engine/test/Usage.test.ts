import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, it } from "vitest";
import * as Paths from "../src/Paths.ts";
import * as Store from "../src/Store.ts";
import * as Usage from "../src/Usage.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-usage-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const run = <A>(program: Effect.Effect<A, never, Usage.Usage>) =>
  program.pipe(
    Effect.provide(
      Usage.layer.pipe(
        Layer.provide(Store.layer),
        Layer.provide(Paths.layer("prod")),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { HOME: dataDir, SHIGOMORI_DATA_DIR: dataDir },
            }),
          ),
        ),
        Layer.merge(TestClock.layer()),
      ),
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
