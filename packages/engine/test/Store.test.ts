import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, it } from "vitest";
import { StoreImportError } from "../src/migrations/importJson.ts";
import * as Paths from "../src/Paths.ts";
import * as Store from "../src/Store.ts";
import { JOURNAL, retireStore } from "../src/dataDirMoveJournal.ts";
import { nodeStore, openNode } from "./lib/nodeStore.ts";

const execFileP = promisify(execFile);

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-store-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const write = (file: string, value: unknown) => {
  mkdirSync(dirname(join(dataDir, file)), { recursive: true });
  writeFileSync(
    join(dataDir, file),
    typeof value === "string" ? value : JSON.stringify(value),
  );
};

const storeLayer = (dir: string) =>
  nodeStore.pipe(
    Layer.provide(Paths.layer("prod")),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { HOME: dir, SHIGOMORI_DATA_DIR: dir },
        }),
      ),
    ),
  );

const platformAt = (dir: string) =>
  Paths.layer("prod").pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { HOME: dir, SHIGOMORI_DATA_DIR: dir } }),
      ),
    ),
  );

const query = <A>(
  run: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>,
  dir = dataDir,
) =>
  Effect.gen(function* () {
    return yield* run(yield* SqlClient.SqlClient);
  }).pipe(Effect.provide(storeLayer(dir)), Effect.runPromise);

const rows = (table: string) =>
  query((sql) => sql`SELECT * FROM ${sql(table)} ORDER BY rowid`).then(
    (found) => found.map((row) => ({ ...row })),
  );

it("opens the database in WAL mode", async () => {
  const [row] = await query(
    (sql) => sql<{ journal_mode: string }>`PRAGMA journal_mode`,
  );
  assert.equal(row?.journal_mode, "wal");
});

it("keeps the database and its journal files the owner's alone, an older build's included", async () => {
  write("store.db", "");
  chmodSync(join(dataDir, "store.db"), 0o644);
  // The journal files live while the store is open.
  const modes = await query((sql) =>
    sql`SELECT 1`.pipe(
      Effect.map(() =>
        ["store.db", "store.db-wal", "store.db-shm"].map(
          (file) => statSync(join(dataDir, file)).mode & 0o777,
        ),
      ),
    ),
  );
  assert.deepEqual(modes, [0o600, 0o600, 0o600]);
});

it("leaves the settings alone in a data dir something has used", async () => {
  write("state.json", {});
  assert.deepEqual(await rows("device_config"), []);
});

// One process holds one store, and node:sqlite waits for a lock by
// blocking its thread, so the store's sharing is between processes:
// the app and the terminal opening it at once, the first time included.
it("opens one store from several processes at once, importing once", async () => {
  write("registry.json", { projects: [{ id: "A", name: "a", path: "/a" }] });
  const opened = await Promise.all(
    [0, 1, 2, 3].map(() =>
      execFileP(
        process.execPath,
        [join(import.meta.dirname, "fixtures", "openStore.ts")],
        { env: { ...process.env, SHIGOMORI_DATA_DIR: dataDir } },
      ),
    ),
  );
  assert.deepEqual(
    opened.map(({ stdout }) => stdout),
    ["1\n", "1\n", "1\n", "1\n"],
  );
});

it("makes the data dir on a device that has none", async () => {
  const fresh = join(dataDir, "fresh", "data");
  await query(() => Effect.void, fresh);
  assert.ok(existsSync(join(fresh, "store.db")));
});

it("fails with the path when the data dir can't be made", async () => {
  const blocked = join(dataDir, "file", "data");
  writeFileSync(join(dataDir, "file"), "");
  await assert.rejects(
    query(() => Effect.void, blocked),
    (error) => {
      assert.ok(error instanceof Store.StoreOpenError);
      assert.equal(error.path, join(blocked, "store.db"));
      return true;
    },
  );
});

it("opens a store a data-folder move retired writable again only once its mover is gone", async () => {
  await query((sql) =>
    Effect.provideService(retireStore, SqlClient.SqlClient, sql),
  );
  const writes = () =>
    query((sql) => sql`UPDATE changes SET version = version + 1`).then(
      () => true,
      () => false,
    );
  assert.equal(await writes(), false);
  const journal = (pid: number) =>
    write(JOURNAL, {
      from: dataDir,
      to: join(dataDir, "..", "elsewhere"),
      partial: join(dataDir, "..", "elsewhere.partial-x"),
      pid,
      // A live pid that started at another time is another process.
      startedAt: pid === process.pid ? Date.now() - process.uptime() * 1000 : 0,
      moved: [],
    });
  // A move still under way: this process plays its mover.
  journal(process.pid);
  assert.equal(await writes(), false);
  journal(4_194_304);
  assert.equal(await writes(), true);
});

it("refuses a store a newer version of the app migrated, and writes nothing to it", async () => {
  await query(
    (sql) =>
      sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (999, 'from_a_later_build')`,
  );
  await assert.rejects(
    query(() => Effect.void),
    (error) => {
      assert.ok(error instanceof Store.StoreOpenError);
      assert.match(
        error.message,
        /made by a newer version of the app; update the app/,
      );
      return true;
    },
  );
});

it("imports what the JSON files hold, and leaves every one in place when it skipped something", async () => {
  const registry = {
    projects: [
      { id: "A", name: "alpha", path: "/r/alpha" },
      { id: "B", name: "beta", path: "/r/beta", extra: 1 },
      { id: "A", name: "again", path: "/r/again" },
    ],
    projectOrder: ["/r/beta", "/r/gone", "/r/beta", "/r/alpha"],
    shelvedWorktrees: { aaaaaaaaaaaa: true, bbbbbbbbbbbb: false },
    autoPullWorktrees: { cccccccccccc: true },
    shelfSnapshots: {
      aaaaaaaaaaaa: { at: 5, head: null, changed: 2 },
      dddddddddddd: { at: "bad" },
    },
    unshelvedAt: { bbbbbbbbbbbb: 7 },
    deviceId: "D3V1C3",
    sharedSettings: {
      entries: {
        theme: { value: "dark", at: 1, by: "x" },
        odd: { from: "a newer build" },
      },
    },
    schemaVersion: 1,
  };
  write("registry.json", registry);
  write("state.json", {
    projectUseLog: { A: [1, 2] },
    launcherUseLog: { "app:cursor": [3] },
    packageScriptUseLog: { A: { dev: [4, 5] } },
    packageScriptSort: { A: "manual" },
    packageScriptOrder: { A: ["dev", "test"] },
    packageScriptLaunchRow: "not a map",
    projects: [{ id: "STALE", name: "stale", path: "/r/stale" }],
  });
  write("config.json", {
    deleteBranchOnRemove: false,
    launchers: [{ id: "x", label: "X", command: "x" }],
    fromNewerBuild: { a: 1 },
    schemaVersion: 1,
  });
  write("projects/A/project.json", { defaultBranch: "main", schemaVersion: 1 });
  write("projects/A/worktrees/aaaaaaaaaaaa.json", {
    title: "T",
    describedAt: 9,
    ports: [{ port: 3000 }],
  });
  write("projects/A/worktrees/eeeeeeeeeeee.json", "{ not json");

  assert.deepEqual(await rows("projects"), [
    { id: "A", name: "alpha", path: "/r/alpha", position: 0 },
    { id: "B", name: "beta", path: "/r/beta", position: 1 },
  ]);
  assert.deepEqual(await rows("project_order"), [
    { path: "/r/beta", position: 0 },
    { path: "/r/gone", position: 1 },
    { path: "/r/alpha", position: 2 },
  ]);
  assert.deepEqual(await rows("worktree_marks"), [
    { worktree_id: "aaaaaaaaaaaa", mark: "shelved" },
    { worktree_id: "cccccccccccc", mark: "autoPull" },
  ]);
  assert.deepEqual(await rows("shelf_snapshots"), [
    { worktree_id: "aaaaaaaaaaaa", at: 5, head: null, changed: 2 },
  ]);
  assert.deepEqual(await rows("unshelved_at"), [
    { worktree_id: "bbbbbbbbbbbb", at: 7 },
  ]);
  assert.deepEqual(await rows("device"), [{ id: 1, device_id: "D3V1C3" }]);
  assert.deepEqual(await rows("shared_settings"), [
    { key: "theme", entry: '{"value":"dark","at":1,"by":"x"}' },
    { key: "odd", entry: '{"from":"a newer build"}' },
  ]);
  assert.deepEqual(await rows("usage"), [
    { log: "project", scope: "A", name: "", at: 1 },
    { log: "project", scope: "A", name: "", at: 2 },
    { log: "launcher", scope: "", name: "app:cursor", at: 3 },
    { log: "script", scope: "A", name: "dev", at: 4 },
    { log: "script", scope: "A", name: "dev", at: 5 },
  ]);
  assert.deepEqual(await rows("script_sort"), [
    { project_id: "A", mode: "manual" },
  ]);
  assert.deepEqual(await rows("script_lists"), [
    { project_id: "A", list: "order", position: 0, name: "dev" },
    { project_id: "A", list: "order", position: 1, name: "test" },
  ]);
  assert.deepEqual(await rows("device_config"), [
    { key: "deleteBranchOnRemove", value: "false" },
    { key: "launchers", value: '[{"id":"x","label":"X","command":"x"}]' },
    { key: "fromNewerBuild", value: '{"a":1}' },
  ]);
  assert.deepEqual(await rows("project_config"), [
    { project_id: "A", key: "defaultBranch", value: '"main"' },
  ]);
  assert.deepEqual(await rows("worktree_data"), [
    {
      project_id: "A",
      worktree_id: "aaaaaaaaaaaa",
      title: "T",
      description: null,
      described_at: 9,
      ports: '[{"port":3000}]',
    },
  ]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir, "registry.json"), "utf8")),
    registry,
  );
});

it("deletes the v2 files once the store is verified to hold what they said, and finds nothing to import after", async () => {
  write("registry.json", {
    projects: [{ id: "A", name: "alpha", path: "/r/alpha" }],
    autoPullWorktrees: { aaaaaaaaaaaa: true },
  });
  write("config.json", { portPool: true });
  write("state.json", { launcherUseLog: { "app:zed": [1, 2] } });
  write("projects/A/project.json", { defaultBranch: "main" });
  // Each file names its version, as v2 wrote them.
  write("projects/A/worktrees/aaaaaaaaaaaa.json", {
    schemaVersion: 1,
    title: "Fox",
  });
  write("running-scripts.json", { ownerPid: 99999, scripts: [] });
  write("updater.json", { channel: "stable" });
  const listing = async () => ({
    projects: await rows("projects"),
    config: await rows("device_config"),
    project: await rows("project_config"),
    data: await rows("worktree_data"),
    marks: await rows("worktree_marks"),
  });
  const first = await listing();
  assert.deepEqual(first.projects, [
    { id: "A", name: "alpha", path: "/r/alpha", position: 0 },
  ]);
  for (const file of [
    "registry.json",
    "config.json",
    "state.json",
    "running-scripts.json",
    "projects",
  ]) {
    assert.ok(!existsSync(join(dataDir, file)), file);
  }
  // Not a file the import reads.
  assert.ok(existsSync(join(dataDir, "updater.json")));
  assert.equal(
    await Effect.runPromise(
      Store.importOwed(openNode).pipe(Effect.provide(platformAt(dataDir))),
    ),
    false,
  );
  assert.deepEqual(await listing(), first);
});

it.each([
  ["a key it doesn't know", { projects: [], projectsSort: "name" }],
  [
    "a project named twice in the order",
    { projects: [], projectOrder: ["/r", "/r"] },
  ],
  ["a key inherited by every object", { projects: [], constructor: { a: 1 } }],
  [
    "a second project under one id",
    {
      projects: [
        { id: "A", name: "a", path: "/a" },
        { id: "A", name: "b", path: "/b" },
      ],
    },
  ],
  [
    "a key of a project it doesn't model",
    { projects: [{ id: "A", name: "a", path: "/a", color: "red" }] },
  ],
  [
    "a shelf snapshot's key it doesn't model",
    {
      projects: [],
      shelfSnapshots: { aaaaaaaaaaaa: { at: 1, head: null, changed: 0, x: 1 } },
    },
  ],
  [
    "a session bound twice",
    {
      projects: [],
      agentSessions: {
        aaaaaaaaaaaa: [
          { harness: "claude", session: "s", state: "idle", at: 1 },
        ],
        bbbbbbbbbbbb: [
          { harness: "claude", session: "s", state: "working", at: 2 },
        ],
      },
    },
  ],
  [
    "an agent session that doesn't parse",
    { projects: [], agentSessions: { aaaaaaaaaaaa: [{ harness: "claude" }] } },
  ],
])(
  "leaves every v2 file in place when the import drops %s",
  async (_, registry) => {
    // Written as it is: JSON.stringify would leave the own key
    // "constructor" in, which the case needs.
    write("registry.json", JSON.stringify(registry));
    write("config.json", { portPool: true });
    await rows("projects");
    assert.ok(existsSync(join(dataDir, "registry.json")));
    assert.ok(existsSync(join(dataDir, "config.json")));
  },
);

it.each([
  [
    "a worktree file's key it doesn't model",
    "projects/A/worktrees/aaaaaaaaaaaa.json",
    { title: "t", note: "n" },
  ],
  [
    "a mirror history that isn't an object",
    "file-sync/mirror-history.json",
    { events: "unreadable" },
  ],
  [
    "mirror invites that aren't a list",
    "file-sync/mirror-invites.json",
    { invites: { a: 1 } },
  ],
  [
    "a running-scripts key it doesn't model",
    "running-scripts.json",
    { ownerPid: 99999, scripts: [], future: { saved: true } },
  ],
])(
  "leaves every v2 file in place when the import drops %s",
  async (_, file, doc) => {
    write("registry.json", { projects: [{ id: "A", name: "a", path: "/a" }] });
    write(file, doc);
    await rows("projects");
    assert.ok(existsSync(join(dataDir, "registry.json")));
    assert.ok(existsSync(join(dataDir, file)));
  },
);

it("starts a data dir nothing has used with a fresh install's settings", async () => {
  assert.deepEqual(await rows("device_config"), [
    { key: "doubutsuNames", value: "true" },
  ]);
});

it("imports once: a later edit to the JSON files is not read", async () => {
  write("registry.json", { projects: [{ id: "A", name: "a", path: "/a" }] });
  await rows("projects");
  write("registry.json", { projects: [] });
  assert.equal((await rows("projects")).length, 1);
});

it("refuses a registry it can't read, naming the file, and imports nothing", async () => {
  write("registry.json", "{ truncated");
  write("config.json", { portPool: true });
  await assert.rejects(rows("projects"), (error) => {
    assert.ok(error instanceof StoreImportError);
    assert.equal(error.path, join(dataDir, "registry.json"));
    return true;
  });
  write("registry.json", { projects: [] });
  assert.deepEqual(await rows("device_config"), [
    { key: "portPool", value: "true" },
  ]);
});

it("refuses a project list that doesn't parse, and a project file", async () => {
  write("registry.json", { projects: [{ id: 1 }] });
  await assert.rejects(rows("projects"), StoreImportError);
  write("registry.json", { projects: [{ id: "A", name: "a", path: "/a" }] });
  write("projects/A/project.json", "[]");
  await assert.rejects(rows("projects"), (error) => {
    assert.ok(error instanceof StoreImportError);
    assert.equal(error.path, join(dataDir, "projects/A/project.json"));
    return true;
  });
});

it("imports a use log longer than one statement can bind", async () => {
  write("state.json", {
    launcherUseLog: { "app:zed": Array.from({ length: 20_000 }, (_, i) => i) },
  });
  const [row] = await query(
    (sql) => sql<{ n: number }>`SELECT count(*) AS n FROM usage`,
  );
  assert.equal(row?.n, 20_000);
});

it("reads what the Go sm reads: missing fields, unknown modes, field by field", async () => {
  write("registry.json", { projects: [{ id: "A", path: "/a" }] });
  write("state.json", { packageScriptSort: { A: "fromNewerBuild" } });
  write("projects/A/worktrees/aaaaaaaaaaaa.json", {
    title: "kept",
    ports: [{ port: 0 }],
  });
  assert.deepEqual(await rows("projects"), [
    { id: "A", name: "", path: "/a", position: 0 },
  ]);
  assert.deepEqual(await rows("script_sort"), [
    { project_id: "A", mode: "fromNewerBuild" },
  ]);
  assert.deepEqual(await rows("worktree_data"), [
    {
      project_id: "A",
      worktree_id: "aaaaaaaaaaaa",
      title: "kept",
      description: null,
      described_at: null,
      ports: null,
    },
  ]);
});

it("reads a null project list as none", async () => {
  write("registry.json", { projects: null });
  assert.deepEqual(await rows("projects"), []);
});

it("skips a settings file no registered project owns", async () => {
  write("registry.json", { projects: [] });
  write("projects/GONE/project.json", "{ truncated");
  assert.deepEqual(await rows("project_config"), []);
});
