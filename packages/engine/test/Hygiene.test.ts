// The facts Tidy's verdicts read, which decide the worktrees it removes
// unforced, their branches with them: work only on its own branch is
// never taken for merged.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Hygiene from "../src/Hygiene.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// A project "repo" (P1), with linked worktrees under the in-project base.
const seedProject = (files: Record<string, string>) => {
  const repo = box.repo("repo", files);
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
  });
  const tree = (name: string) => {
    const path = join(repo, ".shigomori", "wt", name);
    box.git(repo, "worktree", "add", "-q", "-b", name, path);
    return path;
  };
  return { repo, tree };
};

it("tells merged, squash-merged, unique, detached and primary work apart", async () => {
  const { repo, tree } = seedProject({ "a.txt": "a\n" });
  const untouched = tree("untouched");
  writeFileSync(join(untouched, "scratch.txt"), "untracked\n");
  const squashed = tree("squashed");
  writeFileSync(join(squashed, "b.txt"), "b\n");
  box.git(squashed, "add", "b.txt");
  box.git(squashed, "commit", "-q", "-m", "b");
  // The squash merge: main takes the same change in a commit of its own.
  writeFileSync(join(repo, "b.txt"), "b\n");
  box.git(repo, "add", "b.txt");
  box.git(repo, "commit", "-q", "-m", "squash b");
  const unique = tree("unique");
  writeFileSync(join(unique, "c.txt"), "c\n");
  box.git(unique, "add", "c.txt");
  box.git(unique, "commit", "-q", "-m", "c");
  const detached = tree("detached");
  box.git(detached, "checkout", "-q", "--detach");

  const facts = (await box.engine(
    Effect.flatMap(Effect.service(Hygiene.Hygiene), (hygiene) =>
      hygiene.facts({ id: "P1", name: "repo", path: repo }),
    ),
  )) as ReadonlyArray<{
    worktreeId: string;
    uniqueCommits: number | null;
    contentAlreadyInPrimary: boolean;
    holdsPrimaryBranch: boolean;
    untracked: boolean;
  }>;
  const of = (path: string) => {
    const found = facts.find(
      (row) => row.worktreeId === worktreeIdFromPath(path),
    );
    assert.ok(found, path);
    return found;
  };
  const primary = of(repo);
  assert.deepEqual(
    [
      primary.uniqueCommits,
      primary.contentAlreadyInPrimary,
      primary.holdsPrimaryBranch,
    ],
    [null, false, true],
  );
  assert.deepEqual(
    [of(untouched), of(squashed), of(unique), of(detached)].map(
      ({ uniqueCommits, contentAlreadyInPrimary, untracked }) => ({
        uniqueCommits,
        contentAlreadyInPrimary,
        untracked,
      }),
    ),
    [
      { uniqueCommits: 0, contentAlreadyInPrimary: true, untracked: true },
      { uniqueCommits: 1, contentAlreadyInPrimary: true, untracked: false },
      { uniqueCommits: 1, contentAlreadyInPrimary: false, untracked: false },
      {
        uniqueCommits: null,
        contentAlreadyInPrimary: false,
        untracked: false,
      },
    ],
  );
});
