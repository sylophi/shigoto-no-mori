// Durable proof for the package.json scripts' manual order
// (host/lib/scripts/packageScriptStats.ts). The order is one per
// project while each worktree's package.json has its own scripts, so
// arranging on one branch must not lose or shuffle another branch's.
//
// Asserts: the arranged scripts take the order given, a script this
// worktree lacks stays right behind the script it followed (and moves
// with it), one with nothing before it keeps to the front, one whose
// neighbors are all missing falls back to the nearest one present, and
// the stored write merges against what is on disk, skipping the write
// when nothing changed. The launch row's picks go on and off one script
// at a time, per project, and dropping the last one drops the entry. The
// row keeps to the pinned scripts, in list order, only under the manual
// sort and only when this worktree has one of them.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test script-order.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataDirAt } from "@host/lib/util/paths";
import {
  mergeArrangedOrder,
  readLaunchRow,
  readScriptOrder,
  writeLaunchRowScript,
  writeScriptOrder,
} from "@host/lib/scripts/packageScriptStats";
import { pinnedEntries } from "@/components/worktreeDetail/scripts/sortPackageScripts";
import { makeProof } from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("script order proof");
console.log("script order proof\n");

const names = (entries) => entries?.map((entry) => entry.name) ?? null;

// Each case below comes out differently under the plain "arranged, then
// the rest" merge this replaced, which would drop deploy to the end.
async function main() {
  await check(
    "merge: another branch's script stays behind the one it followed",
    () => {
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
    },
  );

  await check("merge: front, runs of missing scripts, new scripts", () => {
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

  await check("launch row: pins count under the manual sort only", () => {
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
  const dir = mkdtempSync(join(tmpdir(), "sm-script-order-"));
  const state = join(dir, "state.json");
  try {
    initDataDirAt(dir);

    await check(
      "store: merges against the stored order and skips a no-op write",
      () => {
        writeScriptOrder("p1", ["dev", "deploy", "test", "lint"]);
        writeScriptOrder("p1", ["lint", "dev", "test"]);
        assert.deepEqual(readScriptOrder("p1"), [
          "lint",
          "dev",
          "deploy",
          "test",
        ]);
        assert.deepEqual(readScriptOrder("p2"), []);

        const bytes = readFileSync(state, "utf8");
        const before = statSync(state).mtimeMs;
        writeScriptOrder("p1", ["lint", "dev", "test"]);
        assert.equal(readFileSync(state, "utf8"), bytes);
        assert.equal(statSync(state).mtimeMs, before);
      },
    );

    await check("store: launch row picks toggle one script at a time", () => {
      writeLaunchRowScript("p1", "dev", true);
      writeLaunchRowScript("p1", "test", true);
      writeLaunchRowScript("p2", "build", true);
      assert.deepEqual(readLaunchRow("p1"), ["dev", "test"]);

      // A pick that changes nothing doesn't write.
      const bytes = readFileSync(state, "utf8");
      writeLaunchRowScript("p1", "dev", true);
      writeLaunchRowScript("p1", "lint", false);
      assert.equal(readFileSync(state, "utf8"), bytes);

      writeLaunchRowScript("p1", "dev", false);
      assert.deepEqual(readLaunchRow("p1"), ["test"]);
      writeLaunchRowScript("p1", "test", false);
      assert.deepEqual(readLaunchRow("p1"), []);
      const stored = JSON.parse(readFileSync(state, "utf8"));
      assert.deepEqual(stored.packageScriptLaunchRow, { p2: ["build"] });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  done();
}

main().catch(fail);
