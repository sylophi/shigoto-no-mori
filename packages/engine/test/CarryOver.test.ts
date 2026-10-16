// Carry-over into a new worktree: each entry copied whole beside the
// worktree and renamed in, so a crash leaves an entry whole or absent,
// never half there to pass for present; the staging folder a crashed
// process left is swept by the next create (real git on a sandbox).
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

it("carries a .worktreeinclude entry over whole, and sweeps a dead create's staging", async () => {
  const repo = box.repo("proj", {
    ".gitignore": "deps/\n",
    ".worktreeinclude": "deps/\n",
  });
  mkdirSync(join(repo, "deps", "lib"), { recursive: true });
  writeFileSync(join(repo, "deps", "lib", "index.js"), "lib\n");
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const place = (yield* worktrees.destination(project, "fox")).path;
      // What a create a crash cut short left beside its worktree.
      const stale = join(dirname(place), ".fox.carry-4194304");
      mkdirSync(join(stale, "deps"), { recursive: true });
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      return {
        path: made.worktree.path,
        beside: readdirSync(dirname(made.worktree.path)),
      };
    }),
  )) as { path: string; beside: string[] };
  assert.equal(
    readFileSync(join(result.path, "deps", "lib", "index.js"), "utf8"),
    "lib\n",
  );
  assert.deepEqual(
    result.beside.filter((entry) => entry.includes(".carry-")),
    [],
  );
  assert.ok(existsSync(result.path));
});

it("leaves an entry whose copy fails out whole, and no staging behind", async () => {
  const repo = box.repo("proj", {
    ".gitignore": "deps/\n",
    ".worktreeinclude": "deps/\n",
  });
  mkdirSync(join(repo, "deps", "lib"), { recursive: true });
  writeFileSync(join(repo, "deps", "lib", "a.js"), "a\n");
  writeFileSync(join(repo, "deps", "lib", "locked.js"), "b\n");
  chmodSync(join(repo, "deps", "lib", "locked.js"), 0o000);
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      return {
        path: made.worktree.path,
        beside: readdirSync(dirname(made.worktree.path)),
      };
    }),
  )) as { path: string; beside: string[] };
  assert.ok(!existsSync(join(result.path, "deps")), "no half-copied entry");
  assert.deepEqual(
    result.beside.filter((entry) => entry.includes(".carry-")),
    [],
  );
});
