import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SharedSettingsDoc } from "@shigomori/contracts/schemas/sharedSettings";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, it } from "vitest";
import * as Paths from "../src/Paths.ts";
import * as SharedSettings from "../src/SharedSettings.ts";
import { nodeStore } from "./lib/nodeStore.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-shared-settings-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const run = <A>(
  program: Effect.Effect<
    A,
    unknown,
    SharedSettings.SharedSettings | SqlClient.SqlClient
  >,
) =>
  program.pipe(
    Effect.provide(
      SharedSettings.layer.pipe(
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
      ),
    ),
    Effect.runPromise,
  );

const entry = (value: string | null, at: number, by = "D") => ({
  value,
  at,
  by,
});

it("reads the shared settings registry.json held, and leaves out an entry it can't read", async () => {
  writeFileSync(
    join(dataDir, "registry.json"),
    JSON.stringify({
      sharedSettings: {
        entries: {
          worktreeSort: entry("recent", 2),
          hiddenWorktreePrefixes: entry(null, 1, "E"),
          odd: { from: "a newer build" },
        },
      },
    }),
  );
  const doc = await run(
    Effect.gen(function* () {
      return yield* (yield* SharedSettings.SharedSettings).read;
    }),
  );
  assert.deepEqual(doc, {
    entries: {
      worktreeSort: entry("recent", 2),
      hiddenWorktreePrefixes: entry(null, 1, "E"),
    },
  });
});

it("stores what an update answers, and keeps a row it can't read", async () => {
  writeFileSync(
    join(dataDir, "registry.json"),
    JSON.stringify({
      sharedSettings: {
        entries: {
          a: entry("one", 1),
          b: entry("two", 2),
          odd: { from: "a newer build" },
        },
      },
    }),
  );
  const [answered, read, rows] = await run(
    Effect.gen(function* () {
      const shared = yield* SharedSettings.SharedSettings;
      const stored = yield* shared.update(
        ({ entries: { a: _a, ...rest } }) => ({
          entries: { ...rest, b: entry("TWO", 3), c: entry(null, 4) },
        }),
      );
      const sql = yield* SqlClient.SqlClient;
      const keys = yield* sql<{
        key: string;
      }>`SELECT key FROM shared_settings ORDER BY rowid`;
      return [stored, yield* shared.read, keys.map(({ key }) => key)];
    }),
  );
  const expected = {
    entries: { b: entry("TWO", 3), c: entry(null, 4) },
  };
  assert.deepEqual(answered, expected);
  assert.deepEqual(read, expected);
  assert.deepEqual(rows, ["b", "odd", "c"]);
});

it("stores nothing when the update hands back the copy it was given", async () => {
  const seen: SharedSettingsDoc[] = [];
  const read = await run(
    Effect.gen(function* () {
      const shared = yield* SharedSettings.SharedSettings;
      yield* shared.update(() => ({ entries: { a: entry("one", 1) } }));
      const answered = yield* shared.update((current) => {
        seen.push(current);
        return current;
      });
      assert.equal(answered, seen[0]);
      return yield* shared.read;
    }),
  );
  assert.deepEqual(read, { entries: { a: entry("one", 1) } });
});
