// Opens the store of the data dir in argv[2] and prints its project
// count, for the proof that two processes can open one store at once.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Paths from "../../src/Paths.ts";
import * as Store from "../../src/Store.ts";

Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM projects`;
  process.stdout.write(`${row?.n}\n`);
}).pipe(
  Effect.provide(
    Store.layer.pipe(
      Layer.provide(Paths.layer("prod")),
      Layer.provide(NodeServices.layer),
    ),
  ),
  Effect.runPromise,
);
