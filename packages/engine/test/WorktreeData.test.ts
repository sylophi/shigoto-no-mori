import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, it } from "vitest";
import * as Paths from "../src/Paths.ts";
import * as WorktreeData from "../src/WorktreeData.ts";
import { nodeStore } from "./lib/nodeStore.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "engine-worktree-data-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const write = (file: string, value: unknown) => {
  mkdirSync(dirname(join(dataDir, file)), { recursive: true });
  writeFileSync(join(dataDir, file), JSON.stringify(value));
};

const run = <A>(program: Effect.Effect<A, never, WorktreeData.WorktreeData>) =>
  program.pipe(
    Effect.provide(
      WorktreeData.layer.pipe(
        Layer.provide(nodeStore),
        Layer.provide(Paths.layer("prod")),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { HOME: dataDir, SHIGOMORI_DATA_DIR: dataDir },
            }),
          ),
        ),
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
  assert.deepEqual(description, {
    title: "T",
    description: "D",
    describedAt: 5,
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
