// The engine under the terminal: the store over Bun's SQLite, and the
// darwin helper beside the binary.
import { dirname, join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { doctorLayer, engineLayer } from "@shigomori/engine/layer";
import * as Store from "@shigomori/engine/Store";
import type { Flavor } from "@shigomori/engine/flavor";

const open: Store.OpenDatabase = (filename) => SqliteClient.make({ filename });
const macfs = join(dirname(process.execPath), "macfs");

export const engine = (flavor: Flavor) =>
  engineLayer({ flavor, store: Store.layer(open), macfs });

// `sm doctor`'s, which opens the store inside each run, so a store that
// won't open still gets its checklist.
export const doctor = (flavor: Flavor) => doctorLayer({ flavor, open, macfs });
