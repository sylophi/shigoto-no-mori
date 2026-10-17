// Opens the store of the data dir SHIGOMORI_DATA_DIR names and prints
// its project count, for the proof that processes can open one store
// at once, and as events the crash proof kills it at (killAt.ts).
import { countEvents } from "./killAt.ts";

countEvents();
const NodeServices = await import("@effect/platform-node/NodeServices");
const Effect = await import("effect/Effect");
const Layer = await import("effect/Layer");
const SqlClient = await import("effect/sql/SqlClient");
const Paths = await import("../../src/Paths.ts");
const { nodeStore } = await import("../lib/nodeStore.ts");

Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM projects`;
  process.stdout.write(`${row?.n}\n`);
}).pipe(
  Effect.provide(
    nodeStore.pipe(
      Layer.provide(Paths.layer("prod")),
      Layer.provide(NodeServices.layer),
    ),
  ),
  Effect.runPromise,
);
