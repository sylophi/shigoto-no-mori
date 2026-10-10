// The v3 migration's reports, as a window or the terminal hears them:
// the import and the move into `wt/` each through its states, a locked
// worktree stuck with git's reason, a start that resumes a move cut
// short counting what was made before, and a start that owes nothing
// (real git on a sandbox data dir).
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoreMigration } from "@shigomori/contracts/schemas/migration";
import { afterEach, beforeEach, it } from "vitest";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// A project "repo" with worktrees a, b and c under the v2 managed root,
// those named in `locked` locked.
const v2Project = (locked: ReadonlyArray<string>) => {
  const repo = box.repo("repo", { "README.md": "hi\n" });
  const v2 = join(box.home, "engine", "worktrees", "repo");
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
  });
  box.side("engine");
  for (const name of ["a", "b", "c"]) {
    box.git(repo, "worktree", "add", "-q", "-b", name, join(v2, name));
  }
  for (const name of locked) {
    box.git(repo, "worktree", "lock", join(v2, name));
  }
  return { repo, v2 };
};

// Each distinct value, the way a screen draws them.
const distinct = (seen: ReadonlyArray<StoreMigration>) =>
  seen.filter(
    (value, i) => JSON.stringify(value) !== JSON.stringify(seen[i - 1]),
  );

it("reports the import and each worktree's move, and a locked one stuck with git's reason", async () => {
  v2Project(["c"]);
  const seen = distinct(await box.start());
  assert.deepEqual(seen[0], { planned: false, import: null, worktrees: null });
  assert.deepEqual(seen[1], {
    planned: true,
    import: { state: "running" },
    worktrees: {
      state: "waiting",
      moved: 0,
      total: 0,
      current: null,
      stuck: [],
    },
  });
  assert.deepEqual(seen[2]?.import, { state: "done" });
  assert.equal(seen[2]?.worktrees?.state, "waiting");
  const moves = seen.slice(3).map((value) => value.worktrees);
  assert.deepEqual(
    moves.map((step) => [
      step?.state,
      step?.moved,
      step?.total,
      step?.current,
      step?.stuck.length,
    ]),
    [
      ["running", 0, 3, null, 0],
      ["running", 0, 3, "a", 0],
      ["running", 1, 3, "a", 0],
      ["running", 1, 3, "b", 0],
      ["running", 2, 3, "b", 0],
      ["running", 2, 3, "c", 0],
      ["running", 2, 3, "c", 1],
      ["stuck", 2, 3, null, 1],
    ],
  );
  const [stuck] = seen.at(-1)?.worktrees?.stuck ?? [];
  assert.equal(stuck?.name, "c");
  assert.match(stuck?.reason ?? "", /locked/);
  assert.ok(!(stuck?.reason ?? "").includes("\n"));
});

it("resumes a move cut short, counting the worktrees moved before", async () => {
  const { repo, v2 } = v2Project(["b", "c"]);
  await box.start();
  // As a crash leaves it: b's move recorded and not tried yet.
  box.git(repo, "worktree", "unlock", join(v2, "b"));
  const db = new DatabaseSync(join(box.side("engine"), "store.db"));
  db.prepare("UPDATE wt_moves SET error = NULL WHERE from_path = ?").run(
    join(v2, "b"),
  );
  db.close();
  const seen = distinct(await box.start());
  const first = seen.find((value) => value.worktrees !== null);
  assert.deepEqual(first?.import, { state: "done" });
  assert.equal(first?.worktrees?.moved, 1);
  assert.equal(first?.worktrees?.total, 3);
  assert.deepEqual(
    first?.worktrees?.stuck.map(({ name }) => name),
    ["c"],
  );
  const last = seen.at(-1);
  assert.equal(last?.worktrees?.state, "stuck");
  assert.equal(last?.worktrees?.moved, 2);
});

it("owes nothing on a fresh data dir, nor once the migration is made", async () => {
  assert.deepEqual((await box.start()).at(-1), {
    planned: true,
    import: null,
    worktrees: null,
  });
  box.remove();
  box = sandbox();
  v2Project([]);
  assert.equal((await box.start()).at(-1)?.worktrees?.state, "done");
  assert.deepEqual((await box.start()).at(-1), {
    planned: true,
    import: null,
    worktrees: null,
  });
});
