import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { it } from "vitest";
import * as WorktreeData from "../src/WorktreeData.ts";
import { freshDataDir, onStoreAt } from "./lib/nodeStore.ts";

const dataDir = freshDataDir("engine-worktree-data-");

const write = (file: string, value: unknown) => {
  mkdirSync(dirname(join(dataDir(), file)), { recursive: true });
  writeFileSync(join(dataDir(), file), JSON.stringify(value));
};

const run = <A>(program: Effect.Effect<A, never, WorktreeData.WorktreeData>) =>
  program.pipe(
    Effect.provide(
      WorktreeData.layer.pipe(
        onStoreAt(dataDir()),
        Layer.merge(TestClock.layer()),
      ),
    ),
    Effect.runPromise,
  );

it("reads the ports a worktree's data file held", async () => {
  write("projects/A/worktrees/aaaaaaaaaaaa.json", {
    title: "T",
    ports: [{ port: 3000 }, { port: 6006, label: "storybook" }],
  });
  const ports = await run(
    Effect.gen(function* () {
      const data = yield* WorktreeData.WorktreeData;
      return [
        yield* data.ports("A", "aaaaaaaaaaaa"),
        yield* data.ports("A", "bbbbbbbbbbbb"),
      ];
    }),
  );
  assert.deepEqual(ports, [
    [{ port: 3000 }, { port: 6006, label: "storybook" }],
    [],
  ]);
});

it("replaces a worktree's ports and keeps its description", async () => {
  const [ports, description, cleared] = await run(
    Effect.gen(function* () {
      const data = yield* WorktreeData.WorktreeData;
      yield* TestClock.setTime(5);
      yield* data.describe("A", "aaaaaaaaaaaa", { title: "T" });
      yield* data.setPorts("A", "aaaaaaaaaaaa", [{ port: 3000 }]);
      yield* data.setPorts("A", "aaaaaaaaaaaa", [
        { port: 4000, label: "  api " },
      ]);
      const replaced = yield* data.ports("A", "aaaaaaaaaaaa");
      yield* data.describe("A", "aaaaaaaaaaaa", { description: "D" });
      const described = yield* data.description("A", "aaaaaaaaaaaa");
      yield* data.setPorts("A", "aaaaaaaaaaaa", []);
      return [replaced, described, yield* data.ports("A", "aaaaaaaaaaaa")];
    }),
  );
  assert.deepEqual(ports, [{ port: 4000, label: "api" }]);
  // Described twice in one millisecond, the second stamped after.
  assert.deepEqual(description, {
    title: "T",
    description: "D",
    describedAt: 6,
  });
  assert.deepEqual(cleared, []);
});

it("carries a worktree's ports when it moves", async () => {
  const ports = await run(
    Effect.gen(function* () {
      const data = yield* WorktreeData.WorktreeData;
      yield* data.setPorts("A", "aaaaaaaaaaaa", [{ port: 3000 }]);
      yield* data.move("A", "aaaaaaaaaaaa", "bbbbbbbbbbbb");
      return [
        yield* data.ports("A", "aaaaaaaaaaaa"),
        yield* data.ports("A", "bbbbbbbbbbbb"),
      ];
    }),
  );
  assert.deepEqual(ports, [[], [{ port: 3000 }]]);
});

it("moves nothing from an id that holds nothing, keeping the target's", async () => {
  const title = await run(
    Effect.gen(function* () {
      const data = yield* WorktreeData.WorktreeData;
      yield* data.describe("A", "aaaaaaaaaaaa", { title: "Kept" });
      // A move undone twice: the second has nothing to bring back.
      yield* data.move("A", "bbbbbbbbbbbb", "aaaaaaaaaaaa");
      return (yield* data.description("A", "aaaaaaaaaaaa")).title;
    }),
  );
  assert.equal(title, "Kept");
});

it("carries a pair described elsewhere only when it is newer", async () => {
  const stored = await run(
    Effect.gen(function* () {
      const data = yield* WorktreeData.WorktreeData;
      yield* data.carry("A", "aaaaaaaaaaaa", {
        title: "Newer",
        description: "",
        describedAt: 20,
      });
      const older = yield* data.carry("A", "aaaaaaaaaaaa", {
        title: "Older",
        description: "kept out",
        describedAt: 10,
      });
      return { older, now: yield* data.description("A", "aaaaaaaaaaaa") };
    }),
  );
  assert.equal(stored.older, false);
  assert.deepEqual(stored.now, {
    title: "Newer",
    description: "",
    describedAt: 20,
  });
});
