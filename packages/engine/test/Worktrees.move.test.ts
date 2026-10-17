// `worktrees move` and its rename: the worktree is managed where it
// lands, and what is kept under its id follows it, port-pool's lease
// included (real git on a sandbox data dir).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { afterEach, beforeEach, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import * as WtFolder from "../src/WtFolder.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
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

// A custom base through a link: git lists its worktrees by the real
// folder, and the base by the link is the same place.
it("reads a worktree under a linked custom base as in place, and a move to its alias as no move", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const real = join(box.home, "trees");
  const link = join(box.home, "trees-link");
  mkdirSync(real);
  symlinkSync(real, link);
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const config = yield* Config.Config;
      const project = yield* registry.register({ name: "proj", path: repo });
      const scope = {
        kind: "project" as const,
        projectId: project.id,
        path: repo,
      };
      yield* config.set(scope, "worktreeLayout", "custom");
      yield* config.set(scope, "customWorktreePath", real);
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const fox = (yield* worktrees.identities(project)).find(
        ({ id }) => id === made.worktree.id,
      );
      assert.ok(fox);
      const linked = yield* worktrees.relocationPlan(project, {
        worktreeLayout: "custom",
        customWorktreePath: link,
      });
      const managed = yield* worktrees.relocationPlan(project, {
        worktreeLayout: "managed-root",
      });
      const moved = yield* worktrees.move(
        { project, worktree: fox },
        join(link, "fox"),
      );
      return { linked, managed, moved: moved.worktree.path, at: fox.path };
    }),
  )) as {
    linked: ReadonlyArray<{ inPlace: boolean }>;
    managed: ReadonlyArray<{ inPlace: boolean; destination: string }>;
    moved: string;
    at: string;
  };
  assert.deepEqual(
    result.linked.map(({ inPlace }) => inPlace),
    [true],
  );
  assert.deepEqual(
    result.managed.map(({ inPlace }) => inPlace),
    [false],
  );
  assert.equal(result.moved, result.at, "the alias moved the worktree");
});

// The managed folder is named for the project as written, and git
// spells the worktree with links resolved: the removal still finds the
// folders it left, with both the data dir and the project linked.
it("prunes a removed worktree's folders under a linked data dir and a project linked by another name", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const link = join(box.home, "proj-link");
  symlinkSync(repo, link);
  const dataDir = box.side("engine");
  const realDataDir = `${dataDir}-real`;
  renameSync(dataDir, realDataDir);
  symlinkSync(realDataDir, dataDir);
  await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: link });
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const fox = (yield* worktrees.identities(project)).find(
        ({ id }) => id === made.worktree.id,
      );
      assert.ok(fox);
      yield* worktrees.remove(
        { project, worktree: fox },
        { force: true, keepBranch: true, skipCleanup: true },
        { report: () => Effect.void, color: false },
      );
    }),
  );
  assert.ok(existsSync(join(realDataDir, "wt")));
  assert.ok(!existsSync(join(realDataDir, "wt", "proj-link")));
});

// A dirty capture whose ref can't follow (a lock git left on it) fails
// the re-key, its rows carried; asked again, the re-key carries it.
it("fails a re-key whose dirty capture can't follow, and carries it when asked again", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const from = "aaaaaaaaaaaa";
      const toPath = join(box.home, "elsewhere", "fox");
      const head = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${from}`, head);
      const to = worktreeIdFromPath(toPath);
      const lock = join(
        repo,
        ".git",
        "refs",
        "shigomori",
        "dirty",
        `${to}.lock`,
      );
      mkdirSync(join(repo, ".git", "refs", "shigomori", "dirty"), {
        recursive: true,
      });
      writeFileSync(lock, "");
      const first = yield* Effect.flip(worktrees.rekey(project, from, toPath));
      rmSync(lock);
      yield* worktrees.rekey(project, from, toPath);
      return {
        refused: Predicate.isTagged(first, "CaptureNotCarried"),
        carried:
          box.git(repo, "rev-parse", `refs/shigomori/dirty/${to}`).trim() ===
          head,
      };
    }),
  )) as { refused: boolean; carried: boolean };
  assert.ok(result.refused);
  assert.ok(result.carried);
});

// A capture kept under the new id from before (an earlier worktree at
// that path) is never written over: the re-key leaves the worktree's own
// under its old id, and the re-key back, an undo's, leaves both as they
// were.
it("never writes a capture over one kept under the id it re-keys to, either way", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const to = worktreeIdFromPath(toPath);
      const own = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "commit", "-q", "--allow-empty", "-m", "stale");
      const stale = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${from}`, own);
      box.git(repo, "update-ref", `refs/shigomori/dirty/${to}`, stale);
      const forward = yield* Effect.flip(
        worktrees.rekey(project, from, toPath),
      );
      yield* worktrees.rekey(project, to, fromPath, {
        expect: own,
        back: true,
      });
      const tip = (id: string) =>
        box.git(repo, "rev-parse", `refs/shigomori/dirty/${id}`).trim();
      return {
        occupied: forward.reason === "occupied",
        own: tip(from) === own,
        stale: tip(to) === stale,
      };
    }),
  )) as { occupied: boolean; own: boolean; stale: boolean };
  assert.deepEqual(result, { occupied: true, own: true, stale: true });
});

// An undo's re-key back carries the capture its re-key found and no
// other: one kept under the new id from before stays there, though the
// old id holds none.
it("carries back only the capture the re-key found, none when it found none", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const to = worktreeIdFromPath(toPath);
      const stale = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${to}`, stale);
      yield* worktrees.rekey(project, from, toPath);
      yield* worktrees.rekey(project, to, fromPath, {
        expect: null,
        back: true,
      });
      const has = (id: string) =>
        box
          .git(
            repo,
            "for-each-ref",
            "--format=%(objectname)",
            `refs/shigomori/dirty/${id}`,
          )
          .trim();
      return { from: has(from), to: has(to) };
    }),
  )) as { from: string; to: string };
  const stale = box.git(repo, "rev-parse", "HEAD").trim();
  assert.deepEqual(result, { from: "", to: stale });
});

// A capture other than the one the caller saw stays where it is, and the
// re-key says so.
it("fails a re-key whose capture changed since its caller looked, the capture left in place", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const head = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${from}`, head);
      const refused = yield* Effect.flip(
        worktrees.rekey(project, from, toPath, { expect: null }),
      );
      return {
        reason: refused.reason,
        kept:
          box.git(repo, "rev-parse", `refs/shigomori/dirty/${from}`).trim() ===
          head,
      };
    }),
  )) as { reason: string; kept: boolean };
  assert.deepEqual(result, { reason: "changed", kept: true });
});
