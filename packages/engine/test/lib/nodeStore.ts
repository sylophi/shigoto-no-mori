// The store over the node driver, as the host opens it.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Store from "../../src/Store.ts";

export const nodeStore = Store.layer((filename) =>
  SqliteClient.make({ filename }),
);
