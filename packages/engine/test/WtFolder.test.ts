// The v3 migration's move of v2's worktrees into `wt/`: the ones git
// can move go with their ids carried over, a locked one stays and is
// reported, and the doctor's fix moves it once it is unlocked (real git
// on a sandbox data dir).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, it, onTestFinished } from "vitest";
import type { WorktreeMoveStep } from "@shigomori/contracts/schemas/migration";
import * as Doctor from "../src/Doctor.ts";
import * as Migration from "../src/Migration.ts";
import * as Registry from "../src/Registry.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import * as WtFolder from "../src/WtFolder.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// A project "repo" with worktrees a, b and a locked c under the v2
// managed root, a's auto-pull mark kept under its v2 id.
const v2Project = () => {
  const repo = box.repo("repo", { "README.md": "hi\n" });
  const dataDir = join(box.home, "engine");
  const v2 = join(dataDir, "worktrees", "repo");
  const wt = join(dataDir, "wt", "repo");
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
    autoPullWorktrees: { [worktreeIdFromPath(join(v2, "a"))]: true },
  });
  box.side("engine");
  for (const name of ["a", "b", "c"]) {
    box.git(repo, "worktree", "add", "-q", "-b", name, join(v2, name));
  }
  box.git(repo, "worktree", "lock", join(v2, "c"));
  return { repo, dataDir, v2, wt };
};

const state = () =>
  box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const folder = yield* WtFolder.WtFolder;
      return {
        autoPull: [...(yield* registry.marked("autoPull"))],
        unmoved: yield* folder.unmoved,
      };
    }),
  ) as Promise<{
    autoPull: string[];
    unmoved: ReadonlyArray<WtFolder.Unmoved>;
  }>;

const found = (doc: Doctor.DoctorDocument) =>
  doc.checks.filter(({ id }) => id === "project-wt-moves");

const listed = (repo: string) =>
  box
    .git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

it("moves v2 worktrees into wt at the first start, and keeps a locked one where it is", async () => {
  const { repo, v2, wt } = v2Project();
  const { autoPull, unmoved } = await state();
  for (const name of ["a", "b"]) {
    assert.ok(existsSync(join(wt, name)), name);
    assert.ok(!existsSync(join(v2, name)), name);
    assert.ok(listed(repo).includes(join(wt, name)), name);
  }
  assert.deepEqual(autoPull, [worktreeIdFromPath(join(wt, "a"))]);
  assert.ok(existsSync(join(v2, "c")));
  assert.equal(unmoved.length, 1);
  assert.equal(unmoved[0]?.fromPath, join(v2, "c"));
  assert.match(unmoved[0]?.error ?? "", /locked/);
});

it("answers the id each moved worktree had for the one it has now", async () => {
  const { v2, wt } = v2Project();
  await state();
  const ids = (await box.engine(
    Effect.flatMap(WtFolder.WtFolder, (folder) => folder.movedIds),
  )) as ReadonlyMap<string, string>;
  assert.deepEqual(
    new Map(ids),
    new Map(
      ["a", "b"].map((name) => [
        worktreeIdFromPath(join(v2, name)),
        worktreeIdFromPath(join(wt, name)),
      ]),
    ),
  );
});

it("reports a worktree the move couldn't take, and the fix moves it once it can", async () => {
  const { repo, dataDir, v2, wt } = v2Project();
  await state();
  const run = (fix: boolean) =>
    box.doctor({
      version: "dev",
      executable: "",
      terminal: false,
      ...(fix
        ? {
            fix: {
              approve: () => Effect.succeed(true),
              failed: () => Effect.void,
            },
          }
        : {}),
    });
  const before = found(await run(false));
  assert.equal(before.length, 1);
  assert.match(before[0]?.detail ?? "", /locked/);
  const stillLocked = await run(true);
  assert.equal(found(stillLocked).length, 1);
  assert.match(stillLocked.repairFailed.join("\n"), /locked/);
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  const fixed = await run(true);
  assert.deepEqual(fixed.repaired, ["moved 1 worktree into wt/ for repo"]);
  assert.deepEqual(found(fixed), []);
  assert.ok(listed(repo).includes(join(wt, "c")));
  assert.ok(!existsSync(join(dataDir, "worktrees")));
  assert.deepEqual((await state()).unmoved, []);
});

it("keeps a worktree something runs in where it is, naming what to close", async () => {
  const { repo, v2, wt } = v2Project();
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  // A shell or a dev server: a process working in a folder of b's.
  mkdirSync(join(v2, "b", "src"));
  const held = spawn("sleep", ["30"], {
    cwd: join(v2, "b", "src"),
    stdio: "ignore",
  });
  onTestFinished(() => {
    held.kill();
  });
  const { unmoved } = await state();
  assert.ok(existsSync(join(wt, "c")));
  assert.ok(existsSync(join(v2, "b")));
  assert.deepEqual(
    unmoved.map(({ fromPath, error }) => [fromPath, error]),
    [[join(v2, "b"), `close sleep (${held.pid}), which runs in it`]],
  );
  held.kill();
  await once(held, "exit");
  const fixed = await box.doctor({
    version: "dev",
    executable: "",
    terminal: false,
    fix: { approve: () => Effect.succeed(true), failed: () => Effect.void },
  });
  assert.deepEqual(found(fixed), []);
  assert.ok(existsSync(join(wt, "b")));
});

it("tries a stuck move again from the page, moving it once nothing runs in it", async () => {
  const { repo, v2, wt } = v2Project();
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  const held = spawn("sleep", ["30"], { cwd: join(v2, "b"), stdio: "ignore" });
  onTestFinished(() => {
    held.kill();
  });
  const retried = () =>
    box.engine(
      Effect.gen(function* () {
        yield* (yield* WtFolder.WtFolder).retryStuck;
        return (yield* (yield* Migration.Migration).current).worktrees;
      }),
    ) as Promise<WorktreeMoveStep>;
  const still = await retried();
  assert.deepEqual(
    { state: still.state, moved: still.moved, stuck: still.stuck },
    {
      state: "stuck",
      moved: 2,
      stuck: [
        { name: "b", reason: `close sleep (${held.pid}), which runs in it` },
      ],
    },
  );
  // Two windows' Retry at once count each move once.
  held.kill();
  await once(held, "exit");
  const [moved] = await Promise.all([retried(), retried()]);
  assert.deepEqual(
    { state: moved.state, moved: moved.moved, stuck: moved.stuck },
    { state: "done", moved: 3, stuck: [] },
  );
  assert.ok(existsSync(join(wt, "b")));
});

it("reads the move's step from the store on a retry, after the doctor moved what was stuck", async () => {
  const { repo, v2 } = v2Project();
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  await state();
  const fixed = await box.doctor({
    version: "dev",
    executable: "",
    terminal: false,
    fix: { approve: () => Effect.succeed(true), failed: () => Effect.void },
  });
  assert.deepEqual(found(fixed), []);
  const step = (await box.engine(
    Effect.gen(function* () {
      yield* (yield* WtFolder.WtFolder).retryStuck;
      return (yield* (yield* Migration.Migration).current).worktrees;
    }),
  )) as WorktreeMoveStep;
  assert.deepEqual(
    {
      state: step.state,
      moved: step.moved,
      total: step.total,
      stuck: step.stuck,
    },
    { state: "done", moved: 3, total: 3, stuck: [] },
  );
});

it("keeps every worktree where it is when lsof can't say what runs in them", async () => {
  const { repo, v2 } = v2Project();
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  box.fakeBin("lsof", "exit 1");
  const { unmoved } = await state();
  assert.deepEqual(
    unmoved.map(({ error }) => error),
    ["a", "b", "c"].map(
      () => "couldn't tell what runs in it: lsof failed (exit code 1)",
    ),
  );
  assert.ok(existsSync(join(v2, "a")));
});

it("carries v2's agent sessions over, bound to their worktree's new id", async () => {
  const repo = box.repo("repo", { "README.md": "hi\n" });
  const v2 = join(box.home, "engine", "worktrees", "repo");
  const wt = join(box.home, "engine", "wt", "repo");
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
    agentSessions: {
      [worktreeIdFromPath(join(v2, "a"))]: [
        {
          harness: "claude",
          session: "s1",
          state: "waiting",
          at: 1700000000000,
          waits: ["Bash:1"],
          title: "Fix the build",
          tool: "Bash",
          need: "pnpm test",
        },
        { harness: "codex", session: "s2", state: "idle", at: 1700000000001 },
        { harness: "claude", state: "idle" },
      ],
    },
  });
  box.side("engine");
  box.git(repo, "worktree", "add", "-q", "-b", "a", join(v2, "a"));
  const bound = (await box.engine(
    Effect.flatMap(Effect.service(Registry.Registry), (registry) =>
      Effect.map(registry.agentSessions, (sessions) => [...sessions]),
    ),
  )) as ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>;
  assert.deepEqual(bound, [
    [
      worktreeIdFromPath(join(wt, "a")),
      [
        {
          harness: "claude",
          session: "s1",
          state: "waiting",
          at: 1700000000000,
          waits: ["Bash:1"],
          title: "Fix the build",
          tool: "Bash",
          need: "pnpm test",
        },
        { harness: "codex", session: "s2", state: "idle", at: 1700000000001 },
      ],
    ],
  ]);
});

const leasesOf = (doc: Doctor.DoctorDocument) =>
  doc.checks.filter(({ id }) => id === "project-leases");

// port-pool on, with a stand-in that keeps its leases in a file beside
// the sandbox and refuses an ensure while a refuse file is there.
const portPool = () => {
  const leases = join(box.home, "pool");
  const refuse = join(box.home, "pool.refuse");
  writeFileSync(leases, "");
  box.fakeBin(
    "port-pool",
    `case "$1" in
  list) while read -r d; do echo "  3000 -> $d (2026-10-12)"; done < "${leases}" ;;
  ensure) [ -f "${refuse}" ] && exit 1; grep -qxF "$2" "${leases}" || echo "$2" >> "${leases}" ;;
  release) grep -vxF "$2" "${leases}" > "${leases}.tmp"; mv "${leases}.tmp" "${leases}" ;;
esac`,
  );
  box.write("config.json", { portPool: true });
  const leased = () =>
    readFileSync(leases, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  return { leases, refuse, leased };
};

// A project whose worktrees port-pool covers, with worktree a under the
// v2 root holding a lease there.
const pooledV2 = () => {
  const repo = box.repo("repo", {
    "port-pool.config.json": JSON.stringify({
      schemaVersion: 1,
      portNames: ["web"],
      envFiles: { ".env.ports": { WEB_PORT: "{web}" } },
    }),
  });
  const dataDir = join(box.home, "engine");
  const v2 = join(dataDir, "worktrees", "repo", "a");
  const wt = join(dataDir, "wt", "repo", "a");
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
  });
  box.side("engine");
  box.git(repo, "worktree", "add", "-q", "-b", "a", v2);
  return { repo, v2, wt };
};

it("moves a worktree's port-pool lease with it", async () => {
  const pool = portPool();
  const { v2, wt } = pooledV2();
  writeFileSync(pool.leases, `${v2}\n`);
  await state();
  assert.ok(existsSync(wt));
  assert.deepEqual(pool.leased(), [wt]);
});

it("says when the move couldn't lease the worktree's ports again, and the fix leases them", async () => {
  const pool = portPool();
  const { v2, wt } = pooledV2();
  writeFileSync(pool.leases, `${v2}\n`);
  writeFileSync(pool.refuse, "");
  await state();
  assert.deepEqual(pool.leased(), []);
  const run = (fix: boolean) =>
    box.doctor({
      version: "dev",
      executable: "",
      terminal: false,
      ...(fix
        ? {
            fix: {
              approve: () => Effect.succeed(true),
              failed: () => Effect.void,
            },
          }
        : {}),
    });
  const [lost] = leasesOf(await run(false));
  assert.match(
    lost?.detail ?? "",
    /1 worktree port-pool covers holds no ports \(a\)/,
  );
  // A fix port-pool still refuses says so, and leaves the finding.
  const refused = await run(true);
  assert.match(
    refused.repairFailed.join("\n"),
    /port-pool ensure for a exited with 1/,
  );
  assert.equal(leasesOf(refused).length, 1);
  rmSync(pool.refuse);
  const fixed = await run(true);
  assert.deepEqual(leasesOf(fixed), []);
  assert.deepEqual(pool.leased(), [wt]);
});

it("counts a lease held under another spelling of the worktree's folder", async () => {
  const pool = portPool();
  const { wt } = pooledV2();
  await state();
  // The lease names the folder through a symlinked parent.
  const alias = join(box.home, "alias");
  symlinkSync(join(wt, ".."), alias);
  writeFileSync(pool.leases, `${join(alias, "a")}\n`);
  const doc = await box.doctor({
    version: "dev",
    executable: "",
    terminal: false,
  });
  assert.deepEqual(leasesOf(doc), []);
});

it("carries the id of a worktree git moved before a crash, by the move's record", async () => {
  const { repo, v2, wt } = v2Project();
  await state();
  const oldId = worktreeIdFromPath(join(v2, "c"));
  const link = realpathSync(join(repo, ".git", "worktrees", "c"));
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  box.git(repo, "worktree", "move", join(v2, "c"), join(wt, "c"));
  const after = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const sql = yield* SqlClient.SqlClient;
      // The record the crashed process left.
      yield* sql`INSERT INTO moving ${sql.insert({
        from_path: join(v2, "c"),
        to_path: join(wt, "c"),
        project_id: "P1",
        link,
        partial: null,
        pid: 4_194_304,
        started_at: 0,
      })}`;
      yield* registry.setMark("autoPull", oldId, true);
      const left = yield* (yield* WtFolder.WtFolder).retry("P1");
      return { left, autoPull: [...(yield* registry.marked("autoPull"))] };
    }),
  )) as { left: ReadonlyArray<WtFolder.Unmoved>; autoPull: string[] };
  assert.deepEqual(after.left, []);
  assert.ok(after.autoPull.includes(worktreeIdFromPath(join(wt, "c"))));
  assert.ok(!after.autoPull.includes(oldId));
});

it("moves the worktrees of a project terrier lists", async () => {
  const repo = box.repo("repo", { "README.md": "hi\n" });
  box.fakeBin(
    "terrier",
    `if [ "$1" = version ]; then echo v0.1.0; else echo '{"projects":[{"path":"${repo}"}]}'; fi`,
  );
  box.write("config.json", { terrier: true });
  const dataDir = box.side("engine");
  const from = join(dataDir, "worktrees", "repo", "a");
  box.git(repo, "worktree", "add", "-q", "-b", "a", from);
  const { unmoved } = await state();
  assert.deepEqual(unmoved, []);
  assert.ok(listed(repo).includes(join(dataDir, "wt", "repo", "a")));
});

it("never carries a v2 worktree's marks onto another checkout at its wt/ path", async () => {
  const { repo, v2, wt } = v2Project();
  await state();
  const oldId = worktreeIdFromPath(join(v2, "c"));
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  box.git(repo, "worktree", "remove", "--force", join(v2, "c"));
  box.git(repo, "worktree", "add", "-q", "-b", "other", join(wt, "c"));
  const after = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      yield* registry.setMark("autoPull", oldId, true);
      yield* (yield* WtFolder.WtFolder).retry("P1");
      return [...(yield* registry.marked("autoPull"))];
    }),
  )) as string[];
  assert.ok(!after.includes(worktreeIdFromPath(join(wt, "c"))));
});
