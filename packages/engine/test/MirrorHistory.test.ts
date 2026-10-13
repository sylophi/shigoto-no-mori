import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import * as MirrorHistory from "../src/MirrorHistory.ts";
import { freshDataDir, onStoreAt } from "./lib/nodeStore.ts";

const dataDir = freshDataDir("engine-mirrorhistory-");

const run = <A>(
  program: Effect.Effect<A, never, MirrorHistory.MirrorHistory>,
) =>
  program.pipe(
    Effect.provide(MirrorHistory.layer.pipe(onStoreAt(dataDir()))),
    Effect.runPromise,
  );

const load = Effect.flatMap(
  MirrorHistory.MirrorHistory,
  (history) => history.load,
);

const connected = { at: 1, kind: "connected" as const, detail: "" };

it("takes a 2.x data dir's threads from mirror-history.json once, skipping a thread it can't read", async () => {
  mkdirSync(join(dataDir(), "file-sync"));
  writeFileSync(
    join(dataDir(), "file-sync", "mirror-history.json"),
    JSON.stringify({ events: { w1: [connected], w2: [{ at: "never" }] } }),
  );
  assert.deepEqual(await run(load), { w1: [connected] });
  // The file stays, and is not read again.
  writeFileSync(
    join(dataDir(), "file-sync", "mirror-history.json"),
    JSON.stringify({ events: { w3: [connected] } }),
  );
  assert.deepEqual(await run(load), { w1: [connected] });
});

it("starts empty without a file, and a save replaces every thread", async () => {
  assert.deepEqual(await run(load), {});
  await run(
    Effect.flatMap(MirrorHistory.MirrorHistory, (history) =>
      history.save({ w1: [connected], w2: [connected] }),
    ),
  );
  await run(
    Effect.flatMap(MirrorHistory.MirrorHistory, (history) =>
      history.save({ w2: [] }),
    ),
  );
  assert.deepEqual(await run(load), { w2: [] });
});
