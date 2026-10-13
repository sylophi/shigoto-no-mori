// The store over the node driver, as the host opens it. `nodeStore`
// stands alone, its migration's reports heard by no one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach } from "vitest";
import * as Migration from "../../src/Migration.ts";
import * as Paths from "../../src/Paths.ts";
import * as Store from "../../src/Store.ts";

export const openNode: Store.OpenDatabase = (filename) =>
  SqliteClient.make({ filename });

export const nodeStore = Store.layer(openNode).pipe(
  Layer.provide(Migration.layer),
);

// A data dir of its own for each test in the file, removed after it.
export const freshDataDir = (prefix: string) => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  return () => dir;
};

// What a store-backed service stands on, its data dir `dataDir` and
// home there too, the store's SqlClient kept beside it for the test.
export const onStoreAt =
  (dataDir: string) =>
  <A, E, R>(service: Layer.Layer<A, E, R>) =>
    service.pipe(
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
    );
