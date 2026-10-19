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
import * as CarryOver from "../src/CarryOver.ts";
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

it("leaves to a move's files step the entries it brings, and seeds the ones its rule leaves out", async () => {
  const repo = box.repo("proj", {
    ".gitignore": ".env.local\nnotes.md\ndeps/\n日本.md\n",
    ".worktreeinclude": ".env.local\nnotes.md\ndeps/\n日本.md\n",
  });
  writeFileSync(join(repo, ".env.local"), "project's\n");
  writeFileSync(join(repo, "notes.md"), "project's\n");
  mkdirSync(join(repo, "deps"));
  writeFileSync(join(repo, "deps", "lib.js"), "project's\n");
  writeFileSync(join(repo, "日本.md"), "project's\n");
  // The user's own excludes list .env.local, which the files step
  // doesn't read: it still brings it.
  const xdg = join(dirname(repo), "xdg");
  mkdirSync(join(xdg, "git"), { recursive: true });
  writeFileSync(join(xdg, "git", "ignore"), ".env.local\n");
  const xdgBefore = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  const path = (await box
    .engine(
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const worktrees = yield* Worktrees.Worktrees;
        const project = yield* registry.register({ name: "proj", path: repo });
        const made = yield* worktrees.create(
          project,
          {
            name: "fox",
            skipSetup: true,
            // A folder-only rule and a name git quotes unless asked not to.
            ignoredFilesFollow: ["/notes.md", "deps/", "/日本.md"],
          },
          { report: () => Effect.void, color: false },
        );
        return made.worktree.path;
      }),
    )
    .finally(() => {
      if (xdgBefore === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = xdgBefore;
    })) as string;
  assert.equal(existsSync(join(path, ".env.local")), false);
  assert.equal(readFileSync(join(path, "notes.md"), "utf8"), "project's\n");
  assert.equal(
    readFileSync(join(path, "deps", "lib.js"), "utf8"),
    "project's\n",
  );
  assert.equal(readFileSync(join(path, "日本.md"), "utf8"), "project's\n");
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

// The Configure view's read and a create's resolve are one reading: the
// matches as git lists them, across every checkout, whatever only one
// of them has.
it("shows what .worktreeinclude matches across checkouts, and none where no checkout has the file", async () => {
  const repo = box.repo("proj", {
    ".gitignore": "deps/\n.env\n",
    ".worktreeinclude": "deps/\n",
  });
  mkdirSync(join(repo, "deps"), { recursive: true });
  writeFileSync(join(repo, "deps", "index.js"), "lib\n");
  const other = box.repo("other", { ".gitignore": ".env\n" });
  writeFileSync(join(other, ".env"), "x\n");
  writeFileSync(join(other, ".worktreeinclude"), ".env\n");
  const bare = box.repo("bare", {});
  const [both, none] = (await box.engine(
    Effect.flatMap(Effect.service(CarryOver.CarryOver), (carryOver) =>
      Effect.all([
        carryOver.includeStatus([repo, other]),
        carryOver.includeStatus([bare]),
      ]),
    ),
  )) as [
    { fileExists: boolean; matchedPaths: string[] },
    { fileExists: boolean; matchedPaths: string[] },
  ];
  assert.deepEqual(both, { fileExists: true, matchedPaths: ["deps/", ".env"] });
  assert.deepEqual(none, { fileExists: false, matchedPaths: [] });
});
