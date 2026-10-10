// Durable proof for the package.json scripts' manual order
// (host/lib/scripts/packageScriptStats.ts, over the engine's Scripts). The order is one per
// project while each worktree's package.json has its own scripts, so
// arranging on one branch must not lose or shuffle another branch's.
//
// Asserts: the arranged scripts take the order given, a script this
// worktree lacks stays right behind the script it followed (and moves
// with it), one with nothing before it keeps to the front, one whose
// neighbors are all missing falls back to the nearest one present, and
// the stored write merges against what is stored. The launch row's
// picks go on and off one script at a time, per project. The
// row keeps to the pinned scripts, in list order, only under the manual
// sort and only when this worktree has one of them.
//
// Run: pnpm test script-order.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeArrangedOrder } from "@shigomori/engine/Scripts";
import * as Stats from "@host/lib/scripts/packageScriptStats";
import {
  pinnedEntries,
  type SortableEntry,
} from "@shigomori/ui/views/worktreeDetail/scripts/sortPackageScripts.ts";
import { afterAll, beforeAll, it } from "vitest";
import { onSandboxEngine } from "./lib/sandboxEngine.mts";
import { hostEngine } from "./lib/smBinary.mts";

// The arrangement as the host reads and writes it, on this file's
// engine.
const readScriptOrder = (projectId: string) =>
  onSandboxEngine(Stats.readScriptOrder(projectId));
const writeScriptOrder = (projectId: string, arranged: readonly string[]) =>
  onSandboxEngine(Stats.writeScriptOrder(projectId, arranged));
const readLaunchRow = (projectId: string) =>
  onSandboxEngine(Stats.readLaunchRow(projectId));
const writeLaunchRowScript = (
  projectId: string,
  scriptName: string,
  onRow: boolean,
) => onSandboxEngine(Stats.writeLaunchRowScript(projectId, scriptName, onRow));

const names = (entries: SortableEntry[] | null) =>
  entries?.map((entry) => entry.name) ?? null;

// Each case below comes out differently under the plain "arranged, then
// the rest" merge this replaced, which would drop deploy to the end.
it("merge: another branch's script stays behind the one it followed", () => {
  // B arranged dev, deploy, test, lint. A has no deploy and moves
  // lint up: deploy still follows dev.
  assert.deepEqual(
    mergeArrangedOrder(
      ["dev", "deploy", "test", "lint"],
      ["dev", "lint", "test"],
    ),
    ["dev", "deploy", "lint", "test"],
  );
  // It moves with its script, wherever that goes.
  assert.deepEqual(
    mergeArrangedOrder(
      ["dev", "deploy", "test", "lint"],
      ["test", "dev", "lint"],
    ),
    ["test", "dev", "deploy", "lint"],
  );
});

it("merge: front, runs of missing scripts, new scripts", () => {
  // Nothing before it: it keeps to the front.
  assert.deepEqual(
    mergeArrangedOrder(["deploy", "dev", "test"], ["test", "dev"]),
    ["deploy", "test", "dev"],
  );
  // A run of missing scripts stays together, in order, behind the
  // nearest script present (dev, since build is missing too).
  assert.deepEqual(
    mergeArrangedOrder(["dev", "build", "deploy", "test"], ["dev", "test"]),
    ["dev", "build", "deploy", "test"],
  );
  // Scripts never stored before take their arranged place.
  assert.deepEqual(
    mergeArrangedOrder(["dev", "deploy", "test"], ["dev", "fresh", "test"]),
    ["dev", "deploy", "fresh", "test"],
  );
});

it("launch row: pins count under the manual sort only", () => {
  const sorted = ["build", "dev", "test", "lint"].map((name) => ({
    name,
    command: name,
  }));
  // List order, not pin order.
  assert.deepEqual(names(pinnedEntries(sorted, "manual", ["test", "dev"])), [
    "dev",
    "test",
  ]);
  // Another sort, no pins, or only another branch's: the fitted row.
  assert.equal(pinnedEntries(sorted, "frequent", ["dev"]), null);
  assert.equal(pinnedEntries(sorted, "manual", []), null);
  assert.equal(pinnedEntries(sorted, "manual", ["deploy"]), null);
});

// One data dir for the store checks: it can only be set once per
// process.
let dir: string;
let close: () => Promise<void>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sm-script-order-"));
  ({ close } = await hostEngine(dir));
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

it("store: merges against the stored order", async () => {
  await writeScriptOrder("p1", ["dev", "deploy", "test", "lint"]);
  await writeScriptOrder("p1", ["lint", "dev", "test"]);
  assert.deepEqual(await readScriptOrder("p1"), [
    "lint",
    "dev",
    "deploy",
    "test",
  ]);
  assert.deepEqual(await readScriptOrder("p2"), []);
});

it("store: launch row picks toggle one script at a time", async () => {
  await writeLaunchRowScript("p1", "dev", true);
  await writeLaunchRowScript("p1", "test", true);
  await writeLaunchRowScript("p2", "build", true);
  assert.deepEqual(await readLaunchRow("p1"), ["dev", "test"]);
  await writeLaunchRowScript("p1", "dev", false);
  assert.deepEqual(await readLaunchRow("p1"), ["test"]);
  await writeLaunchRowScript("p1", "test", false);
  assert.deepEqual(await readLaunchRow("p1"), []);
  assert.deepEqual(await readLaunchRow("p2"), ["build"]);
});
