import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import * as MirrorInvites from "../src/MirrorInvites.ts";
import { freshDataDir, onStoreAt } from "./lib/nodeStore.ts";

const dataDir = freshDataDir("engine-mirrorinvites-");

const run = <A>(
  program: Effect.Effect<A, never, MirrorInvites.MirrorInvites>,
) =>
  program.pipe(
    Effect.provide(MirrorInvites.layer.pipe(onStoreAt(dataDir()))),
    Effect.runPromise,
  );

const load = Effect.flatMap(
  MirrorInvites.MirrorInvites,
  (invites) => invites.load,
);

const landed = {
  peerDeviceId: "peer",
  sourceWorktreeId: "0123456789ab",
  identity: "github.com/sam/app",
  copy: { projectId: "p", worktreeId: "ba9876543210" },
};

it("takes a 2.x data dir's landed invitations from mirror-invites.json once, skipping one it can't read or that never landed", async () => {
  mkdirSync(join(dataDir(), "file-sync"));
  const { copy: _, ...pending } = landed;
  writeFileSync(
    join(dataDir(), "file-sync", "mirror-invites.json"),
    JSON.stringify({ invites: [landed, pending, { peerDeviceId: 3 }] }),
  );
  assert.deepEqual(await run(load), [landed]);
  // The file stays, and is not read again.
  writeFileSync(
    join(dataDir(), "file-sync", "mirror-invites.json"),
    JSON.stringify({ invites: [] }),
  );
  assert.deepEqual(await run(load), [landed]);
});

it("starts empty without a file, and a save replaces every invitation in its order", async () => {
  assert.deepEqual(await run(load), []);
  const second = { ...landed, sourceWorktreeId: "aaaaaaaaaaaa" };
  await run(
    Effect.flatMap(MirrorInvites.MirrorInvites, (invites) =>
      invites.save([landed, second]),
    ),
  );
  assert.deepEqual(await run(load), [landed, second]);
  await run(
    Effect.flatMap(MirrorInvites.MirrorInvites, (invites) =>
      invites.save([second]),
    ),
  );
  assert.deepEqual(await run(load), [second]);
});
