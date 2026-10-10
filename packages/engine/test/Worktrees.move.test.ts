// `worktrees move` and its rename: the worktree is managed where it
// lands, and what is kept under its id follows it, port-pool's lease
// included (real git on a sandbox data dir).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import * as WtFolder from "../src/WtFolder.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

it("moves a worktree into wt, managed, its id carried over", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const dataDir = box.side("engine");
  const from = join(box.home, "elsewhere", "fox");
  const to = join(dataDir, "wt", "proj", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", from);
  const moved = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const found = yield* worktrees.identities(project);
      const fox = found.find(({ name }) => name === "fox");
      assert.ok(fox?.isExternal);
      yield* worktrees.setAutoPull(fox, true);
      const result = yield* worktrees.move({ project, worktree: fox }, to);
      return {
        ...result,
        oldId: fox.id,
        autoPull: [...(yield* registry.marked("autoPull"))],
      };
    }),
  )) as {
    worktree: Worktrees.WorktreeRow;
    previousId: string;
    oldId: string;
    autoPull: string[];
  };
  assert.equal(moved.worktree.path, to);
  assert.ok(!moved.worktree.isExternal);
  assert.equal(moved.previousId, moved.oldId);
  assert.notEqual(moved.worktree.id, moved.oldId);
  assert.deepEqual(moved.autoPull, [moved.worktree.id]);
  assert.ok(!existsSync(from));
});

// A project with port-pool set up, the device's toggle on, and a fake
// port-pool that logs what it is asked.
const pooled = () => {
  box.write("config.json", { portPool: true });
  const dataDir = box.side("engine");
  const log = join(box.home, "port-pool.log");
  box.fakeBin("port-pool", `echo "$@" >> ${log}`);
  const repo = box.repo("proj", {
    "README.md": "hi\n",
    "port-pool.config.json": '{"schemaVersion":1}\n',
  });
  return { repo, dataDir, log };
};

const renaming = (name: string, newName: string) =>
  Effect.gen(function* () {
    const registry = yield* Registry.Registry;
    const worktrees = yield* Worktrees.Worktrees;
    const [project] = yield* registry.projects;
    assert.ok(project);
    const found = yield* worktrees.identities(project);
    const worktree = found.find((id) => id.name === name);
    assert.ok(worktree, name);
    return yield* worktrees.rename(project, worktree.id, newName);
  });

it("renames a worktree in its folder, its id, lease and mirrors' record carried", async () => {
  const { repo, dataDir, log } = pooled();
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const created = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const fox = (yield* worktrees.identities(project)).find(
        ({ id }) => id === created.worktree.id,
      );
      assert.ok(fox);
      yield* worktrees.setAutoPull(fox, true);
      const renamed = yield* worktrees.rename(project, fox.id, "otter");
      return {
        renamed,
        from: fox.path,
        autoPull: [...(yield* registry.marked("autoPull"))],
        movedTo: yield* (yield* WtFolder.WtFolder).movedTo(fox.path),
      };
    }),
  )) as {
    renamed: { worktree: Worktrees.WorktreeRow; previousId: string };
    from: string;
    autoPull: string[];
    movedTo: { _tag: string; value?: string };
  };
  const to = join(dataDir, "wt", "proj", "otter");
  assert.equal(result.renamed.worktree.path, to);
  assert.equal(result.renamed.worktree.name, "otter");
  assert.ok(!result.renamed.worktree.isExternal);
  assert.ok(!existsSync(result.from));
  assert.deepEqual(result.autoPull, [result.renamed.worktree.id]);
  assert.equal(result.movedTo.value, to);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").slice(-2), [
    `release ${result.from}`,
    `ensure ${to}`,
  ]);
});

it("refuses a rename of the primary, to a taken, reserved or unfit name", async () => {
  const { repo, dataDir } = pooled();
  for (const name of ["fox", "owl"]) {
    box.git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      name,
      join(dataDir, "wt", "proj", name),
    );
  }
  const refused = async (name: string, newName: string) => {
    const answer = (await box.engine(renaming(name, newName))) as {
      ok?: boolean;
      error?: string;
    };
    assert.equal(answer.ok, false, `${name} -> ${newName}`);
    return answer.error ?? "";
  };
  await box.engine(
    Effect.flatMap(Effect.service(Registry.Registry), (registry) =>
      registry.register({ name: "proj", path: repo }),
    ),
  );
  assert.match(await refused("proj", "otter"), /primary checkout/);
  assert.match(await refused("fox", "OWL"), /already exists/);
  assert.match(await refused("fox", "root"), /reserved/);
  assert.match(await refused("fox", "a/b"), /not a valid worktree folder name/);
  assert.match(await refused("fox", " "), /not a valid worktree folder name/);
  assert.ok(existsSync(join(dataDir, "wt", "proj", "fox")));
});
