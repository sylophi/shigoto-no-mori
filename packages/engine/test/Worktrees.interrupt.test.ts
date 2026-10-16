// A worktree move or removal interrupted at each step (a cancelled call,
// a closing graph): from the record of the move to its commit nothing
// cuts in, a copy across volumes is undone, and an interrupt after the
// commit finds the move made. The removal's tail, git's remove and the
// forget, runs whole too. Each step is held by the wrappers in
// lib/stopAt.ts; the same steps killed outright are the app's proof
// `interrupted-workflows`.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { afterEach, beforeEach, it } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as WorktreeData from "../src/WorktreeData.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";
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
