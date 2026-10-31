// A worktree move or removal interrupted at each step (a cancelled call,
// a closing graph): from the record of the move to its commit nothing
// cuts in, a copy across volumes is undone and frees its folder, and an
// interrupt after the commit finds the move made. A resume deletes only
// what the move made, finishes the delete of an original a crash cut
// short, leaves a live process's move to it, and carries a capture's
// ref the crash left behind. The removal's tail, git's remove,
// the forget and the branch, runs whole too, and a removal whose git was
// killed mid-delete is finished by a forced one. Each step is held by the
// wrappers in lib/stopAt.ts. The same steps killed outright are the app's
// proof `interrupted-workflows`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, it, onTestFinished } from "vitest";
import * as Config from "../src/Config.ts";
import { errorDocument } from "../src/errorDocument.ts";
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
// the wrappers holding `stop`, interrupted there. Answers where git lists
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

it("an interrupt after git's remove waits for the forget and the branch", async () => {
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
        branch: box.git(repo, "branch", "--list", fox.branch).trim(),
        parent: existsSync(dirname(fox.path)),
      };
    }),
  );
  assert.deepEqual(result, {
    listed: false,
    autoPull: false,
    title: "",
    branch: "",
    parent: false,
  });
});

// git killed as it deletes a checkout (an agent's process tree stopped,
// a logout) leaves the folder without its `.git` and git's entry, which
// git's remove refuses, forced or not. An unforced remove says so. A
// forced one finishes it, without the cleanup that ran before the
// delete (a teardown in what is left would fail), and drops no other
// entry git holds for a folder that is gone.
it("a removal whose git was killed mid-delete is finished by a forced one", async () => {
  const quiet = { report: () => Effect.void, color: false };
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      const repo = box.repo("proj", { "README.md": "hi\n", "keep.txt": "k\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      for (const name of ["fox", "away"]) {
        yield* worktrees.create(project, { name, skipSetup: true }, quiet);
      }
      const rows = yield* worktrees.identities(project);
      const fox = rows.find((row) => row.name === "fox");
      const away = rows.find((row) => row.name === "away")?.path;
      assert.ok(fox && away);
      // Stands for a worktree on a drive that isn't mounted.
      rmSync(away, { recursive: true, force: true });
      const located = { project, worktree: fox };
      yield* worktrees.setAutoPull(fox, true);
      yield* data.describe(project.id, fox.id, { title: "the fox" });
      yield* (yield* Config.Config).patchProject(
        { kind: "project", projectId: project.id, path: repo },
        { defaultBranch: "main", "scripts.teardown": "exit 1" },
      );
      const real = box.git(repo, "--exec-path").trim();
      box.fakeBin(
        "git",
        `case "$*" in *"worktree remove"*) rm -f "${fox.path}/.git" "${fox.path}/README.md"; kill -9 $$;; esac\nexec "${real}/git" "$@"`,
      );
      const killed = yield* Effect.result(
        worktrees.remove(
          located,
          { force: false, keepBranch: false, skipCleanup: true },
          quiet,
        ),
      );
      process.env["PATH"] = path;
      const branch = () =>
        box
          .git(
            repo,
            "branch",
            "--list",
            "--format=%(refname:short)",
            fox.branch,
          )
          .trim();
      const listed = (at: string) =>
        worktrees
          .identities(project)
          .pipe(Effect.map((now) => now.some((row) => row.path === at)));
      const left = {
        listed: yield* listed(fox.path),
        folder: existsSync(fox.path),
        dotGit: existsSync(join(fox.path, ".git")),
        branch: branch(),
      };
      const refused = yield* Effect.flip(
        worktrees.remove(
          located,
          { force: false, keepBranch: false, skipCleanup: false },
          quiet,
        ),
      );
      yield* worktrees.remove(
        located,
        { force: true, keepBranch: false, skipCleanup: false },
        quiet,
      );
      return {
        killed: Result.isFailure(killed),
        left,
        refused: errorDocument(refused),
        listed: yield* listed(fox.path),
        folder: existsSync(fox.path),
        branch: branch(),
        autoPull: (yield* registry.marked("autoPull")).has(fox.id),
        title: (yield* data.description(project.id, fox.id)).title,
        away: yield* listed(away),
      };
    }),
  );
  assert.deepEqual(result, {
    killed: true,
    left: { listed: true, folder: true, dotGit: false, branch: "fox" },
    refused: {
      error: "Worktree is half removed.",
      code: "status-unreadable",
      hint: "Pass --force to finish removing it.",
    },
    listed: false,
    folder: false,
    branch: "",
    autoPull: false,
    title: "",
    away: true,
  });
});

// A project with a worktree fox, marked, and what a resume reads.
const withFox = <A, E>(
  then: (fox: {
    project: Registry.RegisteredProject;
    worktree: Worktrees.WorktreeIdentity;
    repo: string;
  }) => Effect.Effect<A, E, Engine>,
  on: Sandbox = box,
) =>
  on.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = on.repo("proj", { "README.md": "hi\n" });
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

// A checkout's entry of git's, as a move records it.
const linkOf = (dir: string) =>
  realpathSync(
    resolve(
      dir,
      readFileSync(join(dir, ".git"), "utf8")
        .trim()
        .replace(/^gitdir:\s*/, ""),
    ),
  );

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

// A crash partway through the delete of the original a copy across
// volumes leaves, its record left as a dead process's (a defect at the
// delete stands for it). It lands where the delete reaches the `.git`,
// which it takes while anything else is left: an rm takes a folder's
// entries in no set order.
it("a copy across volumes whose delete of the original was cut short is finished by the resume", async () => {
  let cut: string | undefined;
  const crashing = sandbox({
    fileSystem: (real) => ({
      ...real,
      remove: (target, options) =>
        Effect.suspend(() => {
          if (
            cut === undefined ||
            (target !== cut && target !== join(cut, ".git"))
          ) {
            return real.remove(target, options);
          }
          if (readdirSync(cut).some((entry) => entry !== ".git")) {
            rmSync(join(cut, ".git"));
          }
          cut = undefined;
          return Effect.die("crashed mid-delete");
        }),
    }),
  });
  onTestFinished(() => crashing.remove());
  const result = await withFox(
    ({ project, worktree }) =>
      Effect.gen(function* () {
        const worktrees = yield* Worktrees.Worktrees;
        const to = join(dirname(worktree.path), "vixen");
        process.env["PATH"] = stopWrappers(join(crashing.home, "stop-bin"), {
          mark: join(crashing.home, "held"),
          seconds: 0,
          crossVolume: true,
        }).PATH;
        cut = worktree.path;
        const moved = yield* Effect.exit(
          worktrees.move({ project, worktree }, to),
        );
        process.env["PATH"] = path;
        yield* worktrees.resumeMoves;
        const again = yield* worktrees
          .create(
            project,
            { name: "fox", branch: "fox-again", skipSetup: true },
            { report: () => Effect.void, color: false },
          )
          .pipe(Effect.result);
        return {
          crashed: Exit.isFailure(moved),
          records: (yield* records).length,
          again: Result.isSuccess(again)
            ? again.success.worktree.path === worktree.path
            : errorDocument(again.failure),
        };
      }),
    crashing,
  );
  assert.deepEqual(result, { crashed: true, records: 0, again: true });
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
      // Cut before git's move, and another tool made a worktree there since.
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

it("a move into a folder another move still names is refused", async () => {
  const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  onTestFinished(() => void sleeper.kill());
  const result = await withFox(({ project, worktree }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const sql = yield* SqlClient.SqlClient;
      const otter = join(dirname(worktree.path), "otter");
      // otter moved away, its carry still owed, in a process that runs.
      yield* sql`INSERT INTO moving ${sql.insert({
        from_path: otter,
        to_path: join(dirname(worktree.path), "far"),
        project_id: project.id,
        link: "",
        carried: 1,
        partial: null,
        pid: sleeper.pid ?? 0,
        started_at: Date.now(),
      })}`;
      const refused = yield* worktrees
        .move({ project, worktree }, otter)
        .pipe(Effect.flip);
      return refused instanceof Worktrees.WorktreeRefused && refused.reason;
    }),
  );
  assert.equal(result, "move-in-progress");
});

it("an adopt into a folder a move still names is refused before the checkout goes", async () => {
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const sql = yield* SqlClient.SqlClient;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      const outside = join(box.home, "outside", "otter");
      box.git(repo, "worktree", "add", "-q", "-b", "otter", outside);
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external?.isExternal);
      const place = join(
        dirname((yield* worktrees.destination(project, "x")).path),
        "otter",
      );
      yield* sql`INSERT INTO moving ${sql.insert({
        from_path: place,
        to_path: join(box.home, "far"),
        project_id: project.id,
        link: "",
        partial: null,
        pid: process.pid,
        started_at: 0,
      })}`;
      const refused = yield* worktrees
        .adopt(
          { project, worktree: external },
          { force: false },
          {
            report: () => Effect.void,
            color: false,
          },
        )
        .pipe(Effect.flip);
      return {
        reason: refused instanceof Worktrees.WorktreeRefused && refused.reason,
        kept: existsSync(join(outside, "README.md")),
      };
    }),
  );
  assert.deepEqual(result, { reason: "move-in-progress", kept: true });
});

it("a resume knows its checkout by git's entry when git links it relatively", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      box.git(repo, "config", "worktree.useRelativePaths", "true");
      box.git(repo, "worktree", "repair", worktree.path);
      // Deeper, so git writes the link anew.
      const to = join(dirname(worktree.path), "den", "vixen");
      mkdirSync(dirname(to), { recursive: true });
      const link = linkOf(worktree.path);
      box.git(repo, "worktree", "move", worktree.path, to);
      yield* deadRecord(project, worktree.path, to, link);
      yield* worktrees.resumeMoves;
      const now = (yield* worktrees.identities(project)).find(
        (row) => row.path === to,
      );
      assert.ok(now);
      return {
        autoPull: (yield* (yield* Registry.Registry).marked("autoPull")).has(
          now.id,
        ),
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { autoPull: true, records: 0 });
});

it("a resume of a move git made carries it past a checkout git put at the old path since", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      yield* data.describe(project.id, worktree.id, { title: "the fox" });
      const to = join(dirname(worktree.path), "vixen");
      const link = linkOf(worktree.path);
      box.git(repo, "worktree", "move", worktree.path, to);
      box.git(repo, "worktree", "add", "-q", "-b", "newcomer", worktree.path);
      yield* deadRecord(project, worktree.path, to, link);
      yield* worktrees.resumeMoves;
      const vixen = (yield* worktrees.identities(project)).find(
        (row) => row.path === to,
      );
      assert.ok(vixen);
      return {
        vixen: (yield* data.description(project.id, vixen.id)).title,
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { vixen: "the fox", records: 0 });
});

it("a resume undoes a copy git links relatively that a crash left before git was pointed at it", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const sql = yield* SqlClient.SqlClient;
      box.git(repo, "config", "worktree.useRelativePaths", "true");
      box.git(repo, "worktree", "repair", worktree.path);
      const to = join(dirname(worktree.path), "den", "vixen");
      mkdirSync(dirname(to), { recursive: true });
      cpSync(worktree.path, to, { recursive: true });
      yield* sql`INSERT INTO moving ${sql.insert({
        from_path: worktree.path,
        to_path: to,
        project_id: project.id,
        link: linkOf(worktree.path),
        partial: join(dirname(to), ".vixen.partial-x"),
        pid: 4_194_304,
        started_at: 0,
      })}`;
      yield* worktrees.resumeMoves;
      return {
        copy: existsSync(to),
        original: existsSync(join(worktree.path, "README.md")),
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { copy: false, original: true, records: 0 });
});

// The replacement is made before the checkout it replaces goes, so an
// add that fails leaves the external checkout as it was.
it("an adopt whose add fails leaves the checkout it would replace, a detached one's commit with it", async () => {
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      const outside = join(box.home, "outside", "otter");
      box.git(repo, "worktree", "add", "-q", "--detach", outside);
      box.git(outside, "commit", "-q", "--allow-empty", "-m", "only here");
      const tip = box.git(outside, "rev-parse", "HEAD").trim();
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external?.detached);
      // git that refuses the add, and only the add.
      const real = box.git(repo, "--exec-path").trim();
      box.fakeBin(
        "git",
        `case "$*" in *"worktree add"*) echo "fatal: refused" >&2; exit 128;; esac\nexec "${real}/git" "$@"`,
      );
      const failed = yield* worktrees
        .adopt(
          { project, worktree: external },
          { force: false },
          {
            report: () => Effect.void,
            color: false,
          },
        )
        .pipe(Effect.result);
      process.env["PATH"] = path;
      return {
        failed: Result.isFailure(failed),
        held: box.git(outside, "rev-parse", "HEAD").trim() === tip,
      };
    }),
  );
  assert.deepEqual(result, { failed: true, held: true });
});

it("a move git renamed but couldn't record is relinked and carried", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      yield* data.describe(project.id, worktree.id, { title: "the fox" });
      const to = join(dirname(worktree.path), "vixen");
      // git that renames the checkout, then fails writing its records.
      const real = box.git(repo, "--exec-path").trim();
      box.fakeBin(
        "git",
        `case "$*" in *"worktree move"*) mv "${worktree.path}" "${to}"; echo "fatal: could not write gitdir" >&2; exit 128;; esac\nexec "${real}/git" "$@"`,
      );
      const moved = yield* worktrees.move({ project, worktree }, to);
      process.env["PATH"] = path;
      return {
        at: moved.worktree.path === to,
        title: (yield* data.description(project.id, moved.worktree.id)).title,
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { at: true, title: "the fox", records: 0 });
});

it("a resume relinks a checkout git renamed but never recorded", async () => {
  const result = await withFox(({ project, worktree }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      yield* data.describe(project.id, worktree.id, { title: "the fox" });
      const to = join(dirname(worktree.path), "vixen");
      const link = linkOf(worktree.path);
      renameSync(worktree.path, to);
      yield* deadRecord(project, worktree.path, to, link);
      yield* worktrees.resumeMoves;
      const vixen = (yield* worktrees.identities(project)).find(
        (row) => row.path === to,
      );
      assert.ok(vixen);
      return {
        title: (yield* data.description(project.id, vixen.id)).title,
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { title: "the fox", records: 0 });
});

it("a resume relinks a checkout git renamed deeper but never recorded, linked relatively", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      box.git(repo, "config", "worktree.useRelativePaths", "true");
      box.git(repo, "worktree", "repair", worktree.path);
      yield* data.describe(project.id, worktree.id, { title: "the fox" });
      const to = join(dirname(worktree.path), "den", "vixen");
      mkdirSync(dirname(to), { recursive: true });
      const link = linkOf(worktree.path);
      // The rename alone: the link inside still reads from the old place.
      renameSync(worktree.path, to);
      yield* deadRecord(project, worktree.path, to, link);
      yield* worktrees.resumeMoves;
      const vixen = (yield* worktrees.identities(project)).find(
        (row) => row.path === to,
      );
      assert.ok(vixen);
      return {
        title: (yield* data.description(project.id, vixen.id)).title,
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { title: "the fox", records: 0 });
});

it("a move git renamed deeper but couldn't record, linked relatively, is relinked and carried", async () => {
  const result = await withFox(({ project, worktree, repo }) =>
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const data = yield* WorktreeData.WorktreeData;
      box.git(repo, "config", "worktree.useRelativePaths", "true");
      box.git(repo, "worktree", "repair", worktree.path);
      yield* data.describe(project.id, worktree.id, { title: "the fox" });
      const to = join(dirname(worktree.path), "den", "vixen");
      // git that renames the checkout, then fails writing its records.
      const real = box.git(repo, "--exec-path").trim();
      box.fakeBin(
        "git",
        `case "$*" in *"worktree move"*) mkdir -p "${dirname(to)}"; mv "${worktree.path}" "${to}"; echo "fatal: could not write gitdir" >&2; exit 128;; esac\nexec "${real}/git" "$@"`,
      );
      const moved = yield* worktrees.move({ project, worktree }, to);
      process.env["PATH"] = path;
      return {
        at: moved.worktree.path === to,
        title: (yield* data.description(project.id, moved.worktree.id)).title,
        records: (yield* records).length,
      };
    }),
  );
  assert.deepEqual(result, { at: true, title: "the fox", records: 0 });
});

it("an adopt of a locked checkout is refused before anything is made", async () => {
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      const outside = join(box.home, "outside", "otter");
      box.git(repo, "worktree", "add", "-q", "--lock", "-b", "otter", outside);
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external?.locked);
      const refused = yield* worktrees
        .adopt(
          { project, worktree: external },
          { force: false },
          { report: () => Effect.void, color: false },
        )
        .pipe(Effect.flip);
      return {
        reason: refused instanceof Worktrees.WorktreeRefused && refused.reason,
        checkouts: (yield* worktrees.identities(project)).length,
      };
    }),
  );
  assert.deepEqual(result, { reason: "adopt-locked", checkouts: 2 });
});

// A removal of the external checkout that fails takes the replacement
// back, so a later adopt finds the name free.
it("an adopt whose removal fails takes its replacement back, and adopts when asked again", async () => {
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      const outside = join(box.home, "outside", "otter");
      box.git(repo, "worktree", "add", "-q", "-b", "otter", outside);
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external !== undefined);
      // git that refuses to remove the external checkout, and only that.
      const real = box.git(repo, "--exec-path").trim();
      box.fakeBin(
        "git",
        `case "$*" in *"worktree remove"*"${outside}"*) echo "fatal: refused" >&2; exit 128;; esac\nexec "${real}/git" "$@"`,
      );
      const adopt = worktrees.adopt(
        { project, worktree: external },
        { force: false },
        { report: () => Effect.void, color: false },
      );
      const failed = yield* Effect.result(adopt);
      const between = (yield* worktrees.identities(project)).length;
      process.env["PATH"] = path;
      const adopted = yield* adopt;
      return {
        failed: Result.isFailure(failed),
        between,
        managed: !adopted.worktree.isExternal,
        kept: existsSync(outside),
      };
    }),
  );
  assert.deepEqual(result, {
    failed: true,
    between: 2,
    managed: true,
    kept: false,
  });
});

// git can let go of the external checkout and then fail to delete its
// folder: the replacement stays, holding a detached checkout's commits.
it("an adopt whose removal fails after git let go keeps the replacement, the detached commit held", async () => {
  const outside = join(box.home, "outside", "otter");
  const stuck = join(outside, "stuck");
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      box.git(repo, "worktree", "add", "-q", "--detach", outside);
      mkdirSync(stuck);
      writeFileSync(join(stuck, "file"), "x\n");
      box.git(outside, "add", "stuck/file");
      box.git(outside, "commit", "-q", "-m", "only here");
      const tip = box.git(outside, "rev-parse", "HEAD").trim();
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external?.detached);
      chmodSync(stuck, 0o555);
      const failed = yield* worktrees
        .adopt(
          { project, worktree: external },
          { force: false },
          { report: () => Effect.void, color: false },
        )
        .pipe(
          Effect.result,
          Effect.ensuring(Effect.sync(() => chmodSync(stuck, 0o755))),
        );
      const heads = (yield* worktrees.identities(project)).map((listed) =>
        box.git(listed.path, "rev-parse", "HEAD").trim(),
      );
      return { failed: Result.isFailure(failed), held: heads.includes(tip) };
    }),
  );
  assert.deepEqual(result, { failed: true, held: true });
});

// Sol's round 4: git can remove the checkout and its admin HEAD and then
// fail on its logs, still listing the original with no HEAD: the
// replacement stays, holding the detached commit.
it("an adopt whose removal leaves the original listed without a HEAD keeps the replacement", async () => {
  const outside = join(box.home, "outside", "otter");
  let logs = "";
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      box.git(repo, "worktree", "add", "-q", "--detach", outside);
      box.git(outside, "commit", "-q", "--allow-empty", "-m", "only here");
      const tip = box.git(outside, "rev-parse", "HEAD").trim();
      const admin = box
        .git(outside, "rev-parse", "--path-format=absolute", "--git-dir")
        .trim();
      logs = join(admin, "logs");
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external?.detached);
      chmodSync(logs, 0o555);
      const failed = yield* worktrees
        .adopt(
          { project, worktree: external },
          { force: false },
          { report: () => Effect.void, color: false },
        )
        .pipe(
          Effect.result,
          Effect.ensuring(Effect.sync(() => chmodSync(logs, 0o755))),
        );
      const heads = (yield* worktrees.identities(project)).flatMap((listed) => {
        try {
          return [box.git(listed.path, "rev-parse", "HEAD").trim()];
        } catch {
          return [];
        }
      });
      return { failed: Result.isFailure(failed), held: heads.includes(tip) };
    }),
  );
  assert.deepEqual(result, { failed: true, held: true });
});

// Sol's rounds 5 and 6: a commit made in a detached original after it
// was listed is held by no ref the replacement has, so both checkouts
// stay (each holding its commits) and the adopt is refused.
it("an adopt whose original moved on after it was listed keeps both checkouts, the commit kept", async () => {
  const outside = join(box.home, "outside", "otter");
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const repo = box.repo("proj", { "README.md": "hi\n" });
      const project = yield* registry.register({ name: "proj", path: repo });
      box.git(repo, "worktree", "add", "-q", "--detach", outside);
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external?.detached);
      // git that commits in the original as the replacement is added.
      const real = box.git(repo, "--exec-path").trim();
      box.fakeBin(
        "git",
        `case "$*" in *"worktree add"*) "${real}/git" -C "${outside}" commit -q --allow-empty -m late;; esac\nexec "${real}/git" "$@"`,
      );
      const refused = yield* worktrees
        .adopt(
          { project, worktree: external },
          { force: false },
          { report: () => Effect.void, color: false },
        )
        .pipe(Effect.flip);
      process.env["PATH"] = path;
      const listed = yield* worktrees.identities(project);
      return {
        reason: refused instanceof Worktrees.WorktreeRefused && refused.reason,
        late: box.git(outside, "log", "-1", "--format=%s").trim(),
        checkouts: listed.length,
      };
    }),
  );
  assert.deepEqual(result, {
    reason: "adopt-moved",
    late: "late",
    checkouts: 3,
  });
});
