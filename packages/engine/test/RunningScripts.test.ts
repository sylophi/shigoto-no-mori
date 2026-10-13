import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { it } from "vitest";
import * as RunningScripts from "../src/RunningScripts.ts";
import { freshDataDir, onStoreAt } from "./lib/nodeStore.ts";

const dataDir = freshDataDir("engine-running-scripts-");

const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    RunningScripts.RunningScripts | SqlClient.SqlClient
  >,
) =>
  program.pipe(
    Effect.provide(RunningScripts.layer.pipe(onStoreAt(dataDir()))),
    Effect.runPromiseExit,
  );

const devServer: RunningScripts.RunningScript = {
  runId: "r1",
  ownerPid: 4242,
  pid: 5151,
  projectId: "P",
  worktreeId: "W",
  startedAt: 1_000,
  command: "pnpm dev",
};

it("keeps each instance's scripts across opens until removed", async () => {
  await run(
    Effect.gen(function* () {
      const scripts = yield* RunningScripts.RunningScripts;
      yield* scripts.add(devServer);
      yield* scripts.add({
        ...devServer,
        runId: "r2",
        ownerPid: 4343,
        pid: 5252,
        startedAt: 2_000,
      });
    }),
  );
  const listed = await run(
    Effect.flatMap(RunningScripts.RunningScripts, (scripts) => scripts.list),
  );
  assert.ok(Exit.isSuccess(listed));
  assert.deepEqual(
    listed.value.map((script) => [script.runId, script.ownerPid]),
    [
      ["r1", 4242],
      ["r2", 4343],
    ],
  );
  assert.deepEqual(listed.value[0], devServer);
  const after = await run(
    Effect.gen(function* () {
      const scripts = yield* RunningScripts.RunningScripts;
      yield* scripts.remove(["r1"]);
      yield* scripts.remove([]);
      return yield* scripts.list;
    }),
  );
  assert.ok(Exit.isSuccess(after));
  assert.deepEqual(
    after.value.map((script) => script.runId),
    ["r2"],
  );
});

it("refuses a pid of 1 for a script or its owner, which the sweep would signal as everything", async () => {
  const refused = await run(
    Effect.gen(function* () {
      const scripts = yield* RunningScripts.RunningScripts;
      return [
        yield* Effect.exit(scripts.add({ ...devServer, pid: 1 })),
        yield* Effect.exit(scripts.add({ ...devServer, ownerPid: 1 })),
        yield* scripts.list,
      ] as const;
    }),
  );
  assert.ok(Exit.isSuccess(refused));
  const [pid, owner, listed] = refused.value;
  assert.ok(Exit.isFailure(pid) && Exit.isFailure(owner));
  assert.deepEqual(listed, []);
});
