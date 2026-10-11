import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, it } from "vitest";
import * as MirrorInvites from "../src/MirrorInvites.ts";
import * as Paths from "../src/Paths.ts";
import { nodeStore } from "./lib/nodeStore.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-mirrorinvites-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const run = <A>(
  program: Effect.Effect<A, never, MirrorInvites.MirrorInvites>,
) =>
  program.pipe(
    Effect.provide(
      MirrorInvites.layer.pipe(
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
  mkdirSync(join(dataDir, "file-sync"));
  const { copy: _, ...pending } = landed;
  writeFileSync(
    join(dataDir, "file-sync", "mirror-invites.json"),
    JSON.stringify({ invites: [landed, pending, { peerDeviceId: 3 }] }),
  );
  assert.deepEqual(await run(load), [landed]);
  // The file stays, and is not read again.
  writeFileSync(
    join(dataDir, "file-sync", "mirror-invites.json"),
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
