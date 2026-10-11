import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, it } from "vitest";
import * as MirrorHistory from "../src/MirrorHistory.ts";
import * as Paths from "../src/Paths.ts";
import { nodeStore } from "./lib/nodeStore.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-mirrorhistory-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const run = <A>(
  program: Effect.Effect<A, never, MirrorHistory.MirrorHistory>,
) =>
  program.pipe(
    Effect.provide(
      MirrorHistory.layer.pipe(
        Layer.provide(nodeStore),
        Layer.provide(Paths.layer("prod")),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { HOME: dataDir, SHIGOMORI_DATA_DIR: dataDir },
            }),
          ),
        ),
      ),
    ),
    Effect.runPromise,
  );

const load = Effect.flatMap(
  MirrorHistory.MirrorHistory,
  (history) => history.load,
);

const connected = { at: 1, kind: "connected" as const, detail: "" };

it("takes a 2.x data dir's threads from mirror-history.json once, skipping a thread it can't read", async () => {
  mkdirSync(join(dataDir, "file-sync"));
  writeFileSync(
    join(dataDir, "file-sync", "mirror-history.json"),
    JSON.stringify({ events: { w1: [connected], w2: [{ at: "never" }] } }),
  );
  assert.deepEqual(await run(load), { w1: [connected] });
  // The file stays, and is not read again.
  writeFileSync(
    join(dataDir, "file-sync", "mirror-history.json"),
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
