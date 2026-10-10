// Durable proof for the fresh-install seed: a data dir that has never
// been used starts with Doubutsu names on, and unset keeps reading as
// off, so an install from before the seed keeps its adjective-animal
// names. The store's first open seeds it (the engine's import), so the
// app and the terminal can't disagree.
//
// Asserts, against the REAL terminal binary:
// - a data dir that has never been used reads Doubutsu names on, stored
// - an existing install without the key (one with no config.json)
//   stays off, and so does the Settings form
// - an explicit value is kept
//
// Run: pnpm test fresh-install.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { createCliRunner } from "./lib/checkKit.mts";
import { builtSm } from "./lib/smBinary.mts";

// The settings encoders sit beside their React hook, whose imports read
// window.api.deviceId at load. Nothing here calls into window, so a
// bare stand-in is enough to load them under node.
Object.assign(globalThis, {
  window: { api: { deviceId: "fresh-install-check" } },
});
const { fromConfig } = await import("@/hooks/config/settingsForm");

let sandbox: string;
let smBinary = "";
beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-fresh-check-")));
  smBinary = builtSm();
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

let dirCount = 0;
// A data dir for one case, with a runner pointed at it. `files` are
// 2.x files the store imports on its first open.
function install(files: Record<string, object> = {}) {
  dirCount += 1;
  const dir = join(sandbox, `data-${dirCount}`);
  mkdirSync(dir);
  for (const [file, doc] of Object.entries(files)) {
    writeFileSync(join(dir, file), `${JSON.stringify(doc)}\n`);
  }
  const { sm } = createCliRunner(smBinary, {
    ...process.env,
    HOME: sandbox,
    SHIGOMORI_DATA_DIR: dir,
  });
  return {
    // Doubutsu names' effective value and whether the store holds it.
    names: async () => {
      const { docs } = await sm("config", "get", "doubutsuNames");
      const doc = docs.findLast((d) => d.ok === true);
      assert.ok(doc, "config get emitted no ok doc");
      return { value: doc.value, set: doc.set };
    },
    config: async () => {
      const { docs } = await sm("config", "read");
      const doc = docs.findLast((d) => d.ok === true);
      assert.ok(doc, "config read emitted no ok doc");
      return doc.config as Record<string, unknown>;
    },
  };
}

it("a new machine starts with Doubutsu names on", async () => {
  const target = install();
  assert.deepEqual(await target.names(), { value: true, set: true });
  assert.equal(fromConfig(await target.config(), {}).doubutsuNames, true);
});

it("an existing install without the key stays off", async () => {
  const target = install({
    "registry.json": { schemaVersion: 1, projects: [] },
    "state.json": { schemaVersion: 1 },
  });
  assert.deepEqual(await target.names(), { value: false, set: false });
  assert.equal(fromConfig(await target.config(), {}).doubutsuNames, false);
});

it("an explicit value is kept", async () => {
  const target = install({
    "config.json": { schemaVersion: 1, doubutsuNames: false },
  });
  assert.deepEqual(await target.names(), { value: false, set: true });
});
