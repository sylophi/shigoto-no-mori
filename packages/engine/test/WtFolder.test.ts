// The v3 migration's move of v2's worktrees into `wt/`: the ones git
// can move go with their ids carried over, a locked one stays and is
// reported, and the doctor's fix moves it once it is unlocked (real git
// on a sandbox data dir).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
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

it("carries the id of a worktree git moved before a crash", async () => {
  const { repo, v2, wt } = v2Project();
  await state();
  const oldId = worktreeIdFromPath(join(v2, "c"));
  box.git(repo, "worktree", "unlock", join(v2, "c"));
  box.git(repo, "worktree", "move", join(v2, "c"), join(wt, "c"));
  const after = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
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
