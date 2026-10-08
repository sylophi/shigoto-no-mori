import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Scripts from "../src/Scripts.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const run = <A>(
  program: (scripts: Scripts.Scripts["Service"]) => Effect.Effect<A, unknown>,
) => box.engine(Effect.flatMap(Effect.service(Scripts.Scripts), program));

it("keeps another branch's scripts behind the ones they followed", () => {
  assert.deepEqual(
    Scripts.mergeArrangedOrder(
      ["setup", "dev", "deploy", "test", "lint"],
      ["test", "dev", "lint"],
    ),
    ["setup", "test", "dev", "deploy", "lint"],
  );
});

it("stores the sort, the default by its absence, and arranges against the stored order", async () => {
  const repo = box.repo("repo", {
    "package.json": JSON.stringify({ scripts: { a: "1", b: "2" } }),
  });
  const listed = (await run((scripts) =>
    Effect.gen(function* () {
      yield* scripts.setSort("P", "alphabetical");
      yield* scripts.arrange("P", ["x", "a"]);
      yield* scripts.arrange("P", ["b", "a"]);
      const sorted = yield* scripts.list({
        projectId: "P",
        worktreePath: repo,
      });
      yield* scripts.setSort("P", "frequent");
      const reset = yield* scripts.list({ projectId: "P", worktreePath: repo });
      return [sorted.sort, sorted.order, reset.sort];
    }),
  )) as unknown[];
  assert.deepEqual(listed, ["alphabetical", ["x", "b", "a"], "frequent"]);
});

it("puts a script on the launch row and takes it off, once each", async () => {
  const rows = await run((scripts) =>
    Effect.gen(function* () {
      yield* scripts.setOnLaunchRow("P", "dev", true);
      yield* scripts.setOnLaunchRow("P", "test", true);
      yield* scripts.setOnLaunchRow("P", "dev", true);
      const both = yield* scripts.launchRow("P");
      yield* scripts.setOnLaunchRow("P", "dev", false);
      return [both, yield* scripts.launchRow("P")];
    }),
  );
  assert.deepEqual(rows, [["dev", "test"], ["test"]]);
});

it("counts a run in the project's use stats", async () => {
  const repo = box.repo("repo", {
    "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  });
  const usage = (await run((scripts) =>
    Effect.gen(function* () {
      yield* scripts.recordRun("P", "dev");
      return (yield* scripts.list({ projectId: "P", worktreePath: repo }))
        .usage;
    }),
  )) as Record<string, { recentCount: number }>;
  assert.equal(usage.dev?.recentCount, 1);
});
