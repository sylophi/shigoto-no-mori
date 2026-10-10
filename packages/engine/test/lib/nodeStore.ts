// The store over the node driver, as the host opens it. `nodeStore`
// stands alone, its migration's reports heard by no one.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Layer from "effect/Layer";
import * as Migration from "../../src/Migration.ts";
import * as Store from "../../src/Store.ts";

export const openNode: Store.OpenDatabase = (filename) =>
  SqliteClient.make({ filename });

export const nodeStore = Store.layer(openNode).pipe(
  Layer.provide(Migration.layer),
);
