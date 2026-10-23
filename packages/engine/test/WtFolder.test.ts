// The v3 migration's move of v2's worktrees into `wt/`: the ones git
// can move go with their ids carried over, a locked one or one a
// process works in stays, and the doctor's fix moves it once it can
// (real git on a sandbox data dir).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, it, onTestFinished } from "vitest";
import * as Doctor from "../src/Doctor.ts";
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

it("sweeps an emptied v2 root that holds only Finder's .DS_Store", async () => {
  const repo = box.repo("repo", { "README.md": "hi\n" });
  const dataDir = join(box.home, "engine");
  const v2 = join(dataDir, "worktrees", "repo");
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
  });
  box.side("engine");
  box.git(repo, "worktree", "add", "-q", "-b", "a", join(v2, "a"));
  writeFileSync(join(v2, ".DS_Store"), "");
  writeFileSync(join(dataDir, "worktrees", ".DS_Store"), "");
  const { unmoved } = await state();
  assert.deepEqual(unmoved, []);
  assert.ok(!existsSync(join(dataDir, "worktrees")), "the v2 roots are gone");
});
