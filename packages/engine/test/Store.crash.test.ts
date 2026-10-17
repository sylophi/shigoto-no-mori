// The import of a 2.x data dir killed at every point of its run: a
// process opening the store is killed just before one of its events (a
// statement, a file removal), at a spread of them across a whole run, and the next open of each copy holds
// exactly what an import that ran whole holds. The migrations commit
// together, so a kill before the commit leaves nothing and the next
// open imports; one after it leaves the import, and the v2 files go only
// as one whole verified import's (any left are the ones `v2_import`
// names, which the doctor deletes).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, it } from "vitest";
import * as Paths from "../src/Paths.ts";
import { nodeStore } from "./lib/nodeStore.ts";

const root = mkdtempSync(join(tmpdir(), "engine-store-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const V2_FILES = [
  "registry.json",
  "state.json",
  "config.json",
  "projects/A/project.json",
  "projects/A/worktrees/aaaaaaaaaaaa.json",
  "projects/B/project.json",
  "file-sync/mirror-history.json",
];

// A 2.x data dir with something in each file the import reads.
const v2 = join(root, "v2");
const write = (file: string, value: unknown) => {
  mkdirSync(dirname(join(v2, file)), { recursive: true });
  writeFileSync(join(v2, file), JSON.stringify(value));
};
write("registry.json", {
  schemaVersion: 2,
  projects: [
    { id: "A", name: "alpha", path: "/repos/alpha" },
    { id: "B", name: "beta", path: "/repos/beta" },
  ],
  projectOrder: ["/repos/beta", "/repos/alpha"],
  autoPullWorktrees: { aaaaaaaaaaaa: true },
  shelvedWorktrees: { bbbbbbbbbbbb: true },
  deviceId: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
});
write("state.json", {
  projectUseLog: {
    A: Array.from({ length: 3000 }, (_, i) => 1_700_000_000_000 + i),
  },
  packageScriptSort: { A: "recent" },
});
write("config.json", { doubutsuNames: false, deleteBranchOnRemove: true });
write("projects/A/project.json", { schemaVersion: 1, defaultBranch: "main" });
write("projects/A/worktrees/aaaaaaaaaaaa.json", { title: "the fox" });
write("projects/B/project.json", { schemaVersion: 1, defaultBranch: "trunk" });
write("file-sync/mirror-history.json", {
  events: {
    aaaaaaaaaaaa: [{ at: 1_790_000_000_000, kind: "stopped", detail: "" }],
  },
});

const configured = (dir: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { HOME: dir, SHIGOMORI_DATA_DIR: dir } }),
  );

// Every table but the migrator's own (its times) and the record of the
// files deleted (their paths), as sorted rows.
const contents = (dir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('effect_sql_migrations', 'v2_import') ORDER BY name`;
    const held: Record<string, string[]> = {};
    for (const { name } of tables) {
      held[name] = (yield* sql.unsafe(`SELECT * FROM "${name}"`))
        .map((row) => JSON.stringify(row))
        .toSorted();
    }
    const [imported] = yield* sql<{
      files: string;
    }>`SELECT files FROM v2_import`;
    return {
      held,
      deleted:
        imported === undefined ? [] : Object.keys(JSON.parse(imported.files)),
    };
  }).pipe(
    Effect.provide(
      nodeStore.pipe(
        Layer.provide(Paths.layer("prod")),
        Layer.provide(NodeServices.layer),
        Layer.provide(configured(dir)),
      ),
    ),
    Effect.runPromise,
  );

// The fixture's open of the store in a process of its own, which kills
// itself just before its `killAt`th event, a statement or a file removal
// (fixtures/killAt.ts; none: let it finish). Answers whether it finished,
// the signal that ended it, and how many events a finished run made.
const openIn = (dir: string, killAt?: number) =>
  new Promise<{
    readonly finished: boolean;
    readonly signal: NodeJS.Signals | null;
    readonly events: number;
  }>((resolve) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "fixtures", "openStore.ts")],
      {
        env: {
          ...process.env,
          SHIGOMORI_DATA_DIR: dir,
          SHIGOMORI_COUNT_EVENTS: "1",
          ...(killAt === undefined
            ? {}
            : { SHIGOMORI_KILL_AT: String(killAt) }),
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let said = "";
    child.stdout.on("data", (chunk: Buffer) => {
      said += chunk.toString();
    });
    child.once("close", (code, signal) => {
      const events = /^events (\d+)$/m.exec(said)?.[1];
      resolve({ finished: code === 0, signal, events: Number(events ?? 0) });
    });
  });

const copy = (name: string) => {
  const dir = join(root, name);
  cpSync(v2, dir, { recursive: true });
  return dir;
};

it("an import killed anywhere in its run is whole after the next open", async () => {
  const whole = copy("whole");
  const { finished, events } = await openIn(whole);
  assert.ok(finished);
  assert.ok(events > 0, "the whole run counted no events");
  const reference = await contents(whole);
  assert.deepEqual(
    V2_FILES.filter((file) => existsSync(join(whole, file))),
    [],
    "a whole import deletes the files it verified",
  );
  const steps = 40;
  for (let step = 0; step < steps; step++) {
    const dir = copy(`cut-${step}`);
    const killAt = 1 + Math.round((step * (events - 1)) / (steps - 1));
    const cut = await openIn(dir, killAt);
    assert.equal(cut.signal, "SIGKILL", `not killed at event ${killAt}`);
    const after = await contents(dir);
    assert.deepEqual(after.held, reference.held, `killed at event ${killAt}`);
    const left = V2_FILES.filter((file) => existsSync(join(dir, file)));
    // Either the import never deleted (every file is there) or what is
    // left is what its verified record names, for the doctor.
    assert.ok(
      left.length === V2_FILES.length ||
        left.every((file) => after.deleted.includes(join(dir, file))),
      `killed at event ${killAt}: ${JSON.stringify({ left, deleted: after.deleted })}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
