import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Projects from "../src/Projects.ts";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const silent = { report: () => Effect.void, color: false };

// A project with one worktree, and the delete of it, after `before` has
// had the two checkouts.
const deleteProject = async (
  before: (paths: { repo: string; worktree: string }) => void,
) => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  let worktree = "";
  const answer = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const registered = yield* registry.register({ name: "proj", path: repo });
      const made = yield* (yield* Worktrees.Worktrees).create(
        registered,
        { name: "fox", skipSetup: true },
        silent,
      );
      worktree = made.worktree.path;
      before({ repo, worktree });
      const [project] = yield* registry.listed;
      assert.ok(project);
      yield* (yield* Projects.Projects).removeWithFiles(project, silent);
    }),
  );
  const listed = await box.engine(
    Effect.flatMap(Effect.service(Registry.Registry), (r) => r.listed),
  );
  return { repo, worktree, answer, listed: listed as unknown[] };
};

it("deletes the worktrees and the repo folder, and unregisters it", async () => {
  const { repo, worktree, answer, listed } = await deleteProject(() => {});
  assert.equal(answer, undefined, JSON.stringify(answer));
  assert.ok(!existsSync(worktree), "the worktree stayed");
  assert.ok(!existsSync(repo), "the repo folder stayed");
  assert.equal(listed.length, 0);
});

it("deletes nothing while a checkout has uncommitted changes", async () => {
  const { repo, worktree, answer, listed } = await deleteProject((paths) =>
    writeFileSync(join(paths.repo, "loose.txt"), "x\n"),
  );
  assert.equal(
    (answer as Record<string, unknown>)["code"],
    "uncommitted-changes",
    JSON.stringify(answer),
  );
  assert.ok(existsSync(worktree), "the worktree went");
  assert.ok(existsSync(join(repo, "loose.txt")), "the change went");
  assert.equal(listed.length, 1);
});

it("deletes a project whose worktree folder went by hand", async () => {
  const { repo, answer, listed } = await deleteProject((paths) =>
    rmSync(paths.worktree, { recursive: true, force: true }),
  );
  assert.equal(answer, undefined, JSON.stringify(answer));
  assert.ok(!existsSync(repo), "the repo folder stayed");
  assert.equal(listed.length, 0);
});

it("deletes nothing when the repo folder holds another project", async () => {
  const outer = box.repo("outer", { ".gitignore": "vendor/\n" });
  mkdirSync(join(outer, "vendor"));
  const inner = box.repo("outer/vendor/lib", { "README.md": "hi\n" });
  const answer = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const project = yield* registry.register({ name: "outer", path: outer });
      yield* registry.register({ name: "lib", path: inner });
      const listed = (yield* registry.listed).find(
        (row) => row.id === project.id,
      );
      assert.ok(listed);
      yield* (yield* Projects.Projects).removeWithFiles(listed, silent);
    }),
  );
  assert.match(
    (answer as Record<string, unknown>)["error"] as string,
    /holds .*vendor\/lib/,
    JSON.stringify(answer),
  );
  assert.ok(existsSync(join(inner, "README.md")), "the other project went");
});
