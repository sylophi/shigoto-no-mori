import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Layout from "../src/Layout.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const project = { id: "P", path: "/Volumes/Ext/code/repo" };
const base = Effect.service(Layout.Layout).pipe(
  Effect.flatMap((layout) => layout.worktreeBase(project)),
);

it("reads the project's layout once it is configured, and the device's drive setting", async () => {
  box.write("config.json", { managedOnProjectDrive: true });
  box.write("projects/P/project.json", {
    worktreeLayout: "in-project",
  });
  assert.equal(await box.engine(base), "/Volumes/Ext/.smd/wt/repo");
  await box.remove();
  box = sandbox();
  box.write("projects/P/project.json", {
    defaultBranch: "main",
    worktreeLayout: "in-project",
  });
  assert.equal(await box.engine(base), "/Volumes/Ext/code/repo/.shigomori/wt");
});
