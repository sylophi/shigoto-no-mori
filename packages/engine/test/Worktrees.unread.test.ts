// A worktree whose changes git can't read (its index is garbage) lists
// with no count rather than as clean, and no removal calls it safe,
// while the readable checkout beside it still counts (real git on a
// sandbox data dir).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveHygieneVerdict } from "@shigomori/contracts/schemas/hygiene";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

it("lists a worktree whose changes can't be read as unread, not clean", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const fox = join(box.home, "elsewhere", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", fox);
  const admin = box.git(fox, "rev-parse", "--absolute-git-dir").trim();
  writeFileSync(join(admin, "index"), "not an index\n");
  const project = (await box.engine(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({ name: "proj", path: repo }),
    ),
  )) as Registry.RegisteredProject;
  const { rows } = (await box.engine(
    Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
      worktrees.list([project]),
    ),
  )) as { rows: ReadonlyArray<Worktrees.WorktreeRow> };

  const primary = rows.find((row) => row.isPrimary);
  const unread = rows.find((row) => row.name === "fox");
  assert.equal(primary?.changedCount, 0);
  assert.ok(unread);
  assert.equal(unread.changedCount, null);
  assert.equal(unread.lastChangeAt, undefined);
  const verdict = deriveHygieneVerdict(unread, undefined);
  assert.deepEqual(
    { kind: verdict.kind, safe: verdict.safe, needsForce: verdict.needsForce },
    { kind: "dirty", safe: false, needsForce: true },
  );
});
