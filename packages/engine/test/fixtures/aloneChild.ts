// A process that asks for the data-folder lock alone, for the proof
// that two such processes both get it: its home is argv[2], and it exits
// 0 once it held the lock for 100 ms, 1 when it was refused.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as DataDirLock from "../../src/DataDirLock.ts";
import * as Paths from "../../src/Paths.ts";
import type { OpenDatabase } from "../../src/Store.ts";

const openNode: OpenDatabase = (filename, options) =>
  SqliteClient.make({ filename, ...options });

const home = process.argv[2] ?? "";

const program = Effect.flatMap(DataDirLock.DataDirLock, (lock) =>
  lock.alone(Effect.sleep("100 millis"), "3 seconds"),
).pipe(
  Effect.provide(
    DataDirLock.layer(openNode).pipe(
      Layer.provideMerge(Paths.layer("dev")),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
      ),
    ),
  ),
);

Effect.runPromiseExit(program).then((exit) => {
  process.exit(Exit.isSuccess(exit) ? 0 : 1);
});
