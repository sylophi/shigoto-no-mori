import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, it } from "vitest";
import { watchedTables } from "../src/migrations/changes.ts";
import * as Paths from "../src/Paths.ts";
import * as StoreChanges from "../src/StoreChanges.ts";
import * as Usage from "../src/Usage.ts";
import { nodeStore } from "./lib/nodeStore.ts";

const execFileP = promisify(execFile);

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-changes-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const run = <A>(
  program: Effect.Effect<
    A,
    unknown,
    StoreChanges.StoreChanges | Usage.Usage | SqlClient.SqlClient | Scope.Scope
  >,
) =>
  program.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(StoreChanges.layer, Usage.layer).pipe(
        Layer.provideMerge(nodeStore),
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

const tick = TestClock.adjust("500 millis");

it("names the tables this process wrote, once a tick", () =>
  run(
    Effect.gen(function* () {
      const changes = yield* (yield* StoreChanges.StoreChanges).subscribe;
      const usage = yield* Usage.Usage;
      // A tick with nothing written says nothing.
      yield* tick;
      yield* usage.record("script", "P", "dev");
      yield* usage.record("script", "P", "test");
      yield* tick;
      const [first] = yield* changes.pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(first, new Set(["usage"]));
    }),
  ));

it("names the tables another process wrote", () =>
  run(
    Effect.gen(function* () {
      const changes = yield* (yield* StoreChanges.StoreChanges).subscribe;
      // The terminal `sm`'s write, on a connection of its own.
      yield* Effect.promise(() =>
        execFileP(process.execPath, [
          "--disable-warning=ExperimentalWarning",
          "-e",
          `const { DatabaseSync } = require("node:sqlite");
           const db = new DatabaseSync(process.argv[1]);
           db.exec("INSERT INTO device_config VALUES ('theme', '\\"dark\\"')");
           db.exec("INSERT INTO worktree_marks VALUES ('w', 'shelved')");
           db.close();`,
          join(dataDir, "store.db"),
        ]),
      );
      yield* tick;
      const [first] = yield* changes.pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(first, new Set(["device_config", "worktree_marks"]));
    }),
  ));

const unwatched = new Set([
  "icon_cache",
  "clone_verified",
  "saved_terminals",
  "terminal_folder",
]);

it("watches every table but the caches and the saved terminals", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('changes', 'effect_sql_migrations') ORDER BY name`;
      assert.deepEqual(
        tables.map((row) => row.name).filter((name) => !unwatched.has(name)),
        [...watchedTables].toSorted(),
      );
    }),
  ));
