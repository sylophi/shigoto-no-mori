import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, it } from "vitest";
import * as MirrorAgreements from "../src/MirrorAgreements.ts";
import * as Paths from "../src/Paths.ts";
import { nodeStore } from "./lib/nodeStore.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-agreements-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const run = <A>(
  program: Effect.Effect<A, never, MirrorAgreements.MirrorAgreements>,
) =>
  program.pipe(
    Effect.provide(
      MirrorAgreements.layer.pipe(
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
  MirrorAgreements.MirrorAgreements,
  (agreements) => agreements.load,
);

const onMain: MirrorAgreements.GitStateCore = {
  head: { kind: "branch", branch: "main" },
  tip: "a".repeat(40),
  indexTree: "b".repeat(40),
};

it("takes a 2.x data dir's agreements from git-follow.json once, skipping an entry it can't read", async () => {
  mkdirSync(join(dataDir, "file-sync"));
  writeFileSync(
    join(dataDir, "file-sync", "git-follow.json"),
    JSON.stringify({ agreed: { s1: onMain, s2: { head: "nowhere" } } }),
  );
  assert.deepEqual(await run(load), { s1: onMain });
  // The file stays, and is not read again.
  writeFileSync(
    join(dataDir, "file-sync", "git-follow.json"),
    JSON.stringify({ agreed: { s3: onMain } }),
  );
  assert.deepEqual(await run(load), { s1: onMain });
});

it("starts empty without a file, and a save replaces every agreement", async () => {
  assert.deepEqual(await run(load), {});
  await run(
    Effect.flatMap(MirrorAgreements.MirrorAgreements, (agreements) =>
      agreements.save({ s1: onMain, s2: onMain }),
    ),
  );
  await run(
    Effect.flatMap(MirrorAgreements.MirrorAgreements, (agreements) =>
      agreements.save({ s2: { ...onMain, tip: "c".repeat(40) } }),
    ),
  );
  assert.deepEqual(await run(load), {
    s2: { ...onMain, tip: "c".repeat(40) },
  });
});
