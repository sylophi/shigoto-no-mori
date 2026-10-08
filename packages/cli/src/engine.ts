// The engine under the terminal: the store over Bun's SQLite, and the
// darwin helper beside the binary.
import { dirname, join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { engineLayer } from "@shigomori/engine/layer";
import * as Store from "@shigomori/engine/Store";
import type { Flavor } from "@shigomori/engine/flavor";

export const engine = (flavor: Flavor) =>
  engineLayer({
    flavor,
    store: Store.layer((filename) => SqliteClient.make({ filename })),
    macfs: join(dirname(process.execPath), "macfs"),
  });
