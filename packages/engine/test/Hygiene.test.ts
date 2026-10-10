import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

it("measures a tree: blocks once per inode, what removing it frees, and the newest real edit", async () => {
  const root = join(box.home, "tree");
  const old = new Date("2020-01-02T03:04:05Z");
  for (const [file, size] of [
    ["src/a.txt", 5000],
    ["src/deep/b.bin", 70_000],
    ["node_modules/pkg/index.js", 9000],
    ["nested/wt/big.bin", 200_000],
    ["dist/out.js", 300],
  ] as const) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x".repeat(size));
    utimesSync(join(root, file), old, old);
  }
  // Newer, but only where nothing counts as activity.
  writeFileSync(join(root, "node_modules", "pkg", "fresh.js"), "new\n");
  // A link with its other name outside, one with both inside, a clone
  // and a symlink.
  const store = join(box.home, "store.bin");
  writeFileSync(store, "s".repeat(64 * 1024));
  linkSync(store, join(root, "src", "linked-out.bin"));
  writeFileSync(join(root, "src", "pair.bin"), "p".repeat(40_000));
  linkSync(join(root, "src", "pair.bin"), join(root, "src", "pair-2.bin"));
  execFileSync("cp", [
    "-c",
    join(root, "src/deep/b.bin"),
    join(root, "src/clone.bin"),
  ]);
  symlinkSync("a.txt", join(root, "src", "link"));
  const usage = (await box.engine(
    Effect.flatMap(Effect.service(Hygiene.Hygiene), (hygiene) =>
      hygiene.measure(root, []),
    ),
  )) as Hygiene.DiskUsage;
  // The link out of the tree and the clone hold blocks nothing frees.
  assert.ok(usage.reclaimableBytes > 0);
  assert.ok(usage.bytes - usage.reclaimableBytes >= 64 * 1024 + 70_000);
  const missing = (await box.engine(
    Effect.flatMap(Effect.service(Hygiene.Hygiene), (hygiene) =>
      hygiene.measure(join(box.home, "missing"), []),
    ),
  )) as Hygiene.DiskUsage;
  assert.equal(missing.partial, true);
});

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
    primaryRef: string | null;
    holdsPrimaryBranch: boolean;
    untracked: boolean;
  }>;
  const of = (path: string) => {
    const found = facts.find(
      (row) => row.worktreeId === worktreeIdFromPath(path),
    );
    assert.ok(found, path);
    const { worktreeId: _, ...rest } = found;
    return rest;
  };
  const primary = of(repo);
  assert.deepEqual(
    [
      primary.uniqueCommits,
      primary.contentAlreadyInPrimary,
      primary.primaryRef,
      primary.holdsPrimaryBranch,
    ],
    [null, false, "main", true],
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
