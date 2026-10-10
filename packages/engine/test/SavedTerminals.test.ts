import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, it } from "vitest";
import * as Paths from "../src/Paths.ts";
import * as SavedTerminals from "../src/SavedTerminals.ts";
import { nodeStore } from "./lib/nodeStore.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-terminals-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const run = <A>(
  program: Effect.Effect<
    A,
    never,
    SavedTerminals.SavedTerminals | SqlClient.SqlClient
  >,
) =>
  program.pipe(
    Effect.provide(
      SavedTerminals.layer.pipe(
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

const worktreeTerminal: SavedTerminals.SavedTerminal = {
  terminalId: "b",
  owner: { kind: "worktree", projectId: "P", worktreeId: "W" },
  cwd: "/code/app",
  openedAt: 2,
  seq: 7,
  history: "$ vim\r\n",
};

it("keeps terminals across opens, oldest first, until forgotten", async () => {
  await run(
    Effect.gen(function* () {
      const saved = yield* SavedTerminals.SavedTerminals;
      yield* saved.save(worktreeTerminal);
      yield* saved.save({
        terminalId: "a",
        owner: { kind: "device" },
        cwd: "/Users/sam",
        openedAt: 1,
        seq: 0,
        history: "",
      });
    }),
  );
  const listed = await run(
    Effect.flatMap(SavedTerminals.SavedTerminals, (saved) => saved.list),
  );
  assert.deepEqual(
    listed.map((terminal) => terminal.terminalId),
    ["a", "b"],
  );
  assert.deepEqual(listed[1], worktreeTerminal);
  const after = await run(
    Effect.gen(function* () {
      const saved = yield* SavedTerminals.SavedTerminals;
      yield* saved.save({ ...worktreeTerminal, seq: 9 });
      yield* saved.forget("a");
      return yield* saved.list;
    }),
  );
  assert.deepEqual(after, [{ ...worktreeTerminal, seq: 9 }]);
});

it("leaves out a row whose owner it can't read", async () => {
  const listed = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO saved_terminals ${sql.insert({
        terminal_id: "x",
        owner: '{"kind":"project"}',
        cwd: "/",
        opened_at: 0,
        seq: 0,
        history: "",
      })}`.pipe(Effect.orDie);
      return yield* (yield* SavedTerminals.SavedTerminals).list;
    }),
  );
  assert.deepEqual(listed, []);
});

it("remembers the device's last folder", async () => {
  const folders = await run(
    Effect.gen(function* () {
      const saved = yield* SavedTerminals.SavedTerminals;
      const first = yield* saved.lastFolder;
      yield* saved.setLastFolder("/tmp");
      yield* saved.setLastFolder("/Users/sam/code");
      return [first, yield* saved.lastFolder];
    }),
  );
  assert.deepEqual(folders, [Option.none(), Option.some("/Users/sam/code")]);
});
