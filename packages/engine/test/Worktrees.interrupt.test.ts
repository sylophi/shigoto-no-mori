// A worktree move or removal interrupted at each step (a cancelled call,
// a closing graph): from the record of the move to its commit nothing
// cuts in, a copy across volumes is undone and frees its folder, and an
// interrupt after the commit finds the move made. A resume deletes only
// what the move made, leaves a live process's move to it, and carries
// a capture's ref the crash left behind. The removal's tail, git's remove and the
// forget, runs whole too. Each step is held by the wrappers in
// lib/stopAt.ts; the same steps killed outright are the app's proof
// `interrupted-workflows`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, it, onTestFinished } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as WorktreeData from "../src/WorktreeData.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Engine, type Sandbox, sandbox } from "./lib/sandbox.ts";
import { type Stop, stopWrappers } from "./lib/stopAt.ts";

let box: Sandbox;
let path: string | undefined;
beforeEach(() => {
  box = sandbox();
  path = process.env["PATH"];
});
afterEach(async () => {
  process.env["PATH"] = path;
  await box.remove();
});

const held = (mark: string) =>
  Effect.sync(() => existsSync(mark)).pipe(
    Effect.repeat({
      until: (found) => found,
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.timeout("10 seconds"),
  );

// A worktree marked and titled, its move to a sibling folder started with
// the wrappers holding `stop`, interrupted there; answers where git lists
// it after, and what its id holds.
const interruptedMove = (
  stop: (to: string, from: string) => Stop,
  crossVolume = false,
) =>
  box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const fox = (yield* worktrees.identities(project)).find(
        (row) => row.id === made.worktree.id,
      );
      assert.ok(fox);
      yield* worktrees.setAutoPull(fox, true);
      yield* data.describe(project.id, fox.id, { title: "the fox" });
      const to = join(dirname(fox.path), "vixen");
      const mark = join(box.home, "held");
      process.env["PATH"] = stopWrappers(join(box.home, "stop-bin"), {
        stop: stop(to, fox.path),
        mark,
        seconds: 1,
        crossVolume,
      }).PATH;
      const moving = yield* Effect.forkChild(
        worktrees.move({ project, worktree: fox }, to),
      );
      yield* held(mark);
      yield* Fiber.interrupt(moving);
      process.env["PATH"] = path;
      const listed = (yield* worktrees.identities(project)).filter(
        (row) => row.path === fox.path || row.path === to,
      );
      assert.equal(listed.length, 1, JSON.stringify(listed));
      const [now] = listed;
      assert.ok(now);
      return {
        at: now.path === to ? "to" : "from",
        gone: !existsSync(now.path === to ? fox.path : to),
        autoPull: (yield* registry.marked("autoPull")).has(now.id),
        title: (yield* data.description(project.id, now.id)).title,
        partials: readdirSync(dirname(to)).filter((entry) =>
          entry.includes(".partial-"),
        ),
        interrupted: (yield* worktrees.interruptedMoves).length,
      };
    }),
  );

const expectMove = async (
  stop: (to: string, from: string) => Stop,
  at: "from" | "to",
  crossVolume = false,
) => {
  const result = await interruptedMove(stop, crossVolume);
  assert.deepEqual(result, {
    at,
    gone: true,
    autoPull: true,
    title: "the fox",
    partials: [],
    interrupted: 0,
  });
};

it("an interrupt before git's move waits for the move and its carry", () =>
  expectMove(
    () => ({ tool: "git", when: "before", match: "worktree move" }),
    "to",
  ));

it("an interrupt after git's move waits for the carry", () =>
  expectMove(
    () => ({ tool: "git", when: "after", match: "worktree move" }),
    "to",
  ));

it("an interrupt while the old folders are pruned finds the move made", () =>
  expectMove(
    (_to, from) => ({ tool: "rmdir", when: "before", match: dirname(from) }),
    "to",
  ));

it("an interrupt during a copy across volumes undoes it", () =>
  expectMove(
    () => ({ tool: "cp", when: "after", match: ".partial-" }),
    "from",
    true,
  ));

it("an interrupt once the copy is renamed in waits for the move", () =>
  expectMove(
    (to) => ({
      tool: "git",
      when: "before",
      match: `worktree repair -- ${to}`,
    }),
    "to",
    true,
  ));

it("an interrupt once git is pointed at the copy waits for the carry", () =>
  expectMove(
    (to) => ({ tool: "git", when: "after", match: `worktree repair -- ${to}` }),
    "to",
    true,
  ));

it("an interrupt after git's remove waits for the forget", async () => {
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const fox = (yield* worktrees.identities(project)).find(
        (row) => row.id === made.worktree.id,
      );
      assert.ok(fox);
      yield* worktrees.setAutoPull(fox, true);
      yield* data.describe(project.id, fox.id, { title: "the fox" });
      const mark = join(box.home, "held");
      process.env["PATH"] = stopWrappers(join(box.home, "stop-bin"), {
        stop: { tool: "git", when: "after", match: "worktree remove" },
        mark,
        seconds: 1,
      }).PATH;
      const removing = yield* Effect.forkChild(
        worktrees.remove(
          { project, worktree: fox },
          { force: true, keepBranch: false, skipCleanup: true },
          { report: () => Effect.void, color: false },
        ),
      );
      yield* held(mark);
      yield* Fiber.interrupt(removing);
      process.env["PATH"] = path;
      return {
        listed: (yield* worktrees.identities(project)).some(
          (row) => row.id === fox.id,
        ),
        autoPull: (yield* registry.marked("autoPull")).has(fox.id),
        title: (yield* data.description(project.id, fox.id)).title,
      };
    }),
  );
  assert.deepEqual(result, { listed: false, autoPull: false, title: "" });
});

// A project with a worktree fox, marked, and what a resume reads.
const withFox = <A, E>(
  then: (fox: {
    project: Registry.RegisteredProject;
    worktree: Worktrees.WorktreeIdentity;
    repo: string;
  }) => Effect.Effect<A, E, Engine>,
) =>
  box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      const made = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const worktree = (yield* worktrees.identities(project)).find(
        (row) => row.id === made.worktree.id,
      );
      assert.ok(worktree);
      yield* worktrees.setAutoPull(worktree, true);
      return yield* then({ project, worktree, repo });
    }),
  );

// The record a process left that is gone (no pid 2^22 runs here).
const deadRecord = (
  project: Registry.RegisteredProject,
  from: string,
  to: string,
  link: string,
  carried = 0,
) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`INSERT INTO moving ${sql.insert({
        from_path: from,
        to_path: to,
        project_id: project.id,
        link,
        carried,
        partial: null,
        pid: 4_194_304,
        started_at: 0,
      })}`,
  );

// A checkout's `.git` file, as a move records it.
const linkOf = (dir: string) => readFileSync(join(dir, ".git"), "utf8").trim();

const records = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ from_path: string }>`SELECT from_path FROM moving`,
);

it("a resume never deletes a folder the move didn't make", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const to = join(dirname(worktree.path), "vixen");
      const link = linkOf(worktree.path);
      box.git(repo, "worktree", "move", worktree.path, to);
      // Someone's folder at the old path since the crash.
      mkdirSync(worktree.path);
      writeFileSync(join(worktree.path, "notes.txt"), "mine\n");
      yield* deadRecord(project, worktree.path, to, link);
      yield* worktrees.resumeMoves;
      return {
        kept: existsSync(join(worktree.path, "notes.txt")),
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { kept: true, records: 0 });
});

it("a cancelled copy across volumes frees its folder for the next move", async () => {
  const result = await withFox(({ project, worktree }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const to = join(dirname(worktree.path), "vixen");
      const mark = join(box.home, "held");
      process.env["PATH"] = stopWrappers(join(box.home, "stop-bin"), {
        stop: { tool: "cp", when: "after", match: ".partial-" },
        mark,
        seconds: 1,
        crossVolume: true,
      }).PATH;
      const moving = yield* Effect.forkChild(
        worktrees.move({ project, worktree }, to),
      );
      yield* held(mark);
      yield* Fiber.interrupt(moving);
      process.env["PATH"] = path;
      const left = (yield* records).length;
      const moved = yield* worktrees.move({ project, worktree }, to);
      return { left, at: moved.worktree.path === to };
    }),
  );
  assert.deepEqual(result, { left: 0, at: true });
});

it("a move another live process holds is left to it", async () => {
  const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  onTestFinished(() => void sleeper.kill());
  const result = await withFox(({ project, worktree }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const sql = yield* SqlClient.SqlClient;
      const to = join(dirname(worktree.path), "vixen");
      yield* sql`INSERT INTO moving ${sql.insert({
        from_path: worktree.path,
        to_path: to,
        project_id: project.id,
        link: linkOf(worktree.path),
        partial: null,
        pid: sleeper.pid ?? 0,
        started_at: Date.now(),
      })}`;
      yield* worktrees.resumeMoves;
      const refused = yield* worktrees
        .move({ project, worktree }, to)
        .pipe(Effect.flip);
      return {
        records: (yield* records).length,
        interrupted: (yield* worktrees.interruptedMoves).length,
        refused: refused instanceof Worktrees.WorktreeRefused && refused.reason,
      };
    }),
  );
  assert.deepEqual(result, {
    records: 1,
    interrupted: 0,
    refused: "move-in-progress",
  });
});

it("a resume carries a dirty capture the crash left under the old id", async () => {
  const result = (await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const to = join(dirname(worktree.path), "vixen");
      const head = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${worktree.id}`, head);
      const link = linkOf(worktree.path);
      box.git(repo, "worktree", "move", worktree.path, to);
      yield* deadRecord(project, worktree.path, to, link);
      yield* worktrees.resumeMoves;
      const now = (yield* worktrees.identities(project)).find(
        (row) => row.path === to,
      );
      assert.ok(now);
      const refs = box
        .git(
          repo,
          "for-each-ref",
          "--format=%(refname)",
          "refs/shigomori/dirty",
        )
        .trim();
      return {
        refs,
        wanted: `refs/shigomori/dirty/${now.id}`,
        records: (yield* records).length,
      };
    }),
  )) as { refs: string; wanted: string; records: number };
  assert.deepEqual(result.refs, result.wanted);
  assert.equal(result.records, 0);
});

it("a resume never takes another checkout at the destination for the moved one", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      const to = join(dirname(worktree.path), "vixen");
      yield* data.describe(project.id, worktree.id, { title: "the fox" });
      // Cut before git's move; another tool made a worktree there since.
      yield* deadRecord(project, worktree.path, to, linkOf(worktree.path));
      box.git(repo, "worktree", "add", "-q", "-b", "vixen", to);
      yield* worktrees.resumeMoves;
      const vixen = (yield* worktrees.identities(project)).find(
        (row) => row.path === to,
      );
      assert.ok(vixen);
      return {
        fox: (yield* data.description(project.id, worktree.id)).title,
        vixen: (yield* data.description(project.id, vixen.id)).title,
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { fox: "the fox", vixen: "", records: 0 });
});

it("a resume of a move carried before the crash never re-keys again", async () => {
  const result = await withFox(({ project, worktree }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      const to = join(dirname(worktree.path), "vixen");
      const moved = yield* worktrees.move({ project, worktree }, to);
      yield* data.describe(project.id, moved.worktree.id, { title: "moved" });
      // What a folder made at the old path since keeps under the old id.
      yield* data.describe(project.id, worktree.id, { title: "newcomer" });
      yield* deadRecord(project, worktree.path, to, linkOf(to), 1);
      yield* worktrees.resumeMoves;
      return {
        moved: (yield* data.description(project.id, moved.worktree.id)).title,
        newcomer: (yield* data.description(project.id, worktree.id)).title,
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, {
    moved: "moved",
    newcomer: "newcomer",
    records: 0,
  });
});

it("a create refuses a path a cut-short move still names", async () => {
  const result = await withFox(({ project, worktree }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO moving ${sql.insert({
        from_path: join(dirname(worktree.path), "otter"),
        to_path: join(dirname(worktree.path), "elsewhere"),
        project_id: project.id,
        link: "",
        partial: null,
        pid: process.pid,
        started_at: 0,
      })}`;
      const refused = yield* worktrees
        .create(
          project,
          { name: "otter", skipSetup: true },
          { report: () => Effect.void, color: false },
        )
        .pipe(Effect.flip);
      return refused instanceof Worktrees.WorktreeRefused && refused.reason;
    }),
  );
  assert.equal(result, "move-in-progress");
});

it("a resume leaves a copy this process is making alone", async () => {
  const result = await withFox(({ project, worktree }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const to = join(dirname(worktree.path), "vixen");
      const mark = join(box.home, "held");
      process.env["PATH"] = stopWrappers(join(box.home, "stop-bin"), {
        stop: { tool: "cp", when: "after", match: ".partial-" },
        mark,
        seconds: 2,
        crossVolume: true,
      }).PATH;
      const moving = yield* Effect.forkChild(
        worktrees.move({ project, worktree }, to),
      );
      yield* held(mark);
      yield* worktrees.resumeMoves;
      yield* worktrees.resumeMoves;
      const during = (yield* worktrees.interruptedMoves).length;
      const moved = yield* Fiber.join(moving);
      process.env["PATH"] = path;
      return {
        during,
        at: moved.worktree.path === to,
        records: (yield* records).length,
        partials: readdirSync(dirname(to)).filter((entry) =>
          entry.includes(".partial-"),
        ),
      };
    }),
  );
  assert.deepEqual(result, { during: 0, at: true, records: 0, partials: [] });
});
