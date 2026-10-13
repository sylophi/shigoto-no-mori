import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import * as MirrorAgreements from "../src/MirrorAgreements.ts";
import { freshDataDir, onStoreAt } from "./lib/nodeStore.ts";

const dataDir = freshDataDir("engine-agreements-");

const run = <A>(
  program: Effect.Effect<A, never, MirrorAgreements.MirrorAgreements>,
) =>
  program.pipe(
    Effect.provide(MirrorAgreements.layer.pipe(onStoreAt(dataDir()))),
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
  mkdirSync(join(dataDir(), "file-sync"));
  writeFileSync(
    join(dataDir(), "file-sync", "git-follow.json"),
    JSON.stringify({ agreed: { s1: onMain, s2: { head: "nowhere" } } }),
  );
  assert.deepEqual(await run(load), { s1: onMain });
  // The file stays, and is not read again.
  writeFileSync(
    join(dataDir(), "file-sync", "git-follow.json"),
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
