import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Projects from "../src/Projects.ts";
import * as Registry from "../src/Registry.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

it("starts a new project's primary with auto-pull when autoPullNew is on", async () => {
  const on = box.repo("on");
  box.write("config.json", { autoPullNew: true, autoPullPrimaryOnly: true });
  const marked = await box.engine(
    Effect.gen(function* () {
      yield* (yield* Projects.Projects).add(on);
      return yield* (yield* Registry.Registry).marked("autoPull");
    }),
  );
  assert.deepEqual(
    [...(marked as ReadonlySet<string>)],
    [worktreeIdFromPath(on)],
  );
});

it("leaves a new project's primary alone while autoPullNew is off", async () => {
  const off = box.repo("off");
  const marked = await box.engine(
    Effect.gen(function* () {
      yield* (yield* Projects.Projects).add(off);
      return yield* (yield* Registry.Registry).marked("autoPull");
    }),
  );
  assert.deepEqual([...(marked as ReadonlySet<string>)], []);
});
