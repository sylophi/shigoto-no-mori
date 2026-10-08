// Durable proof for the fresh-install seed: a data dir that has never
// been used starts with Doubutsu names on, and the app and the CLI
// agree on it. The app's bootstrap (host/lib/bootstrap.ts) and the CLI
// (cli/state.go seedFreshInstall) each seed on their first run, and
// unset keeps reading as off, so an install from before the seed keeps
// its adjective-animal names.
//
// Asserts, against the REAL sm binary:
// - a data dir that has never been used is seeded by whichever of the
//   app's bootstrap and the CLI runs first, the other leaves it alone,
//   and neither seeds again
// - an existing install without the key (even one with no config.json)
//   stays off in both engines and in the Settings form
// - explicit values are never touched
// The pick itself (cli/names.go, which the app's New Worktree pre-pick
// asks through `sm worktrees destination`) is proven in cli/names_test.go.
//
// Run: pnpm test fresh-install.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir, FRESH_CONFIG_SEED } from "@host/lib/bootstrap";
import { initDataDirAt } from "@host/lib/util/paths";
import type { GlobalConfig } from "@shigomori/contracts/schemas/config";
import { errorCodeOf } from "@shigomori/contracts/errors";
import { afterAll, beforeAll, it } from "vitest";
import { createCliRunner } from "./lib/checkKit.mts";
import { builtSm } from "./lib/smBinary.mts";

// The settings encoders sit beside their React hook, whose imports read
// window.api.deviceId at load. Nothing here calls into window, so a
// bare stand-in is enough to load them under node.
Object.assign(globalThis, {
  window: { api: { deviceId: "fresh-install-check" } },
});
const { fromConfig } = await import("@/hooks/config/useSettingsSave");

let sandbox: string;
// Built inside the try below, so a failed build still reports and
// cleans up.
let smBinary = "";
beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-fresh-check-")));
  // ensureDataDir takes its folder as an argument, so every case below
  // passes its own. This one only satisfies the one-shot init.
  initDataDirAt(join(sandbox, "unused"));
  smBinary = builtSm();
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

let dirCount = 0;
// A data dir for one case, with an sm runner pointed at it. `create`
// false leaves the folder missing, the way a new machine has it.
function install({ create = true }: { create?: boolean } = {}) {
  dirCount += 1;
  const dir = join(sandbox, `data-${dirCount}`);
  if (create) mkdirSync(dir);
  const { sm } = createCliRunner(smBinary, {
    ...process.env,
    HOME: sandbox,
    SHIGOMORI_DATA_DIR: dir,
  });
  const configPath = join(dir, "config.json");
  return {
    dir,
    write: (file: string, doc: object) =>
      writeFileSync(join(dir, file), `${JSON.stringify(doc)}\n`),
    config: (): GlobalConfig => {
      try {
        return JSON.parse(readFileSync(configPath, "utf8"));
      } catch (error) {
        if (errorCodeOf(error) === "ENOENT") return {};
        throw error;
      }
    },
    configText: () => readFileSync(configPath, "utf8"),
    // What the CLI reports for Doubutsu names: its effective value and
    // whether the file holds it.
    names: async () => {
      const { docs } = await sm("config", "get", "doubutsuNames");
      const doc = docs.findLast((d) => d.ok === true);
      assert.ok(doc, "config get emitted no ok doc");
      return { value: doc.value, set: doc.set };
    },
  };
}

const namesOn = { value: true, set: true };
const namesOff = { value: false, set: false };

it("the seed is Doubutsu names alone", () => {
  assert.deepEqual(FRESH_CONFIG_SEED, { doubutsuNames: true });
});

it("the app seeds a new machine once, and the CLI agrees", async () => {
  const target = install({ create: false });
  await ensureDataDir(target.dir);
  assert.equal(target.config().doubutsuNames, true);
  const seeded = target.configText();
  assert.deepEqual(await target.names(), namesOn);
  assert.equal(fromConfig(target.config(), {}).doubutsuNames, true);
  await ensureDataDir(target.dir);
  assert.equal(target.configText(), seeded, "a second launch rewrote config");
});

it("the CLI seeds a new machine once, and the app agrees", async () => {
  const target = install();
  assert.deepEqual(await target.names(), namesOn);
  const seeded = target.configText();
  await ensureDataDir(target.dir);
  await target.names();
  assert.equal(target.configText(), seeded, "config changed after the seed");
  assert.equal(fromConfig(target.config(), {}).doubutsuNames, true);
});

it("an existing install without the key stays off", async () => {
  // Projects registered, config.json never written: app first.
  const appFirst = install();
  appFirst.write("registry.json", { schemaVersion: 1, projects: [] });
  await ensureDataDir(appFirst.dir);
  assert.ok(!("doubutsuNames" in appFirst.config()));
  assert.deepEqual(await appFirst.names(), namesOff);
  // An app-bootstrapped install (state.json, empty config): CLI first.
  const cliFirst = install();
  cliFirst.write("state.json", { schemaVersion: 1 });
  cliFirst.write("config.json", { schemaVersion: 1 });
  assert.deepEqual(await cliFirst.names(), namesOff);
  await ensureDataDir(cliFirst.dir);
  assert.deepEqual(cliFirst.config(), { schemaVersion: 1 });
  assert.equal(fromConfig(cliFirst.config(), {}).doubutsuNames, false);
});

it("explicit values are never touched", async () => {
  const explicit = async (value: boolean) => {
    const target = install();
    const doc = { doubutsuNames: value };
    target.write("config.json", doc);
    await ensureDataDir(target.dir);
    assert.deepEqual(await target.names(), { value, set: true });
    assert.deepEqual(target.config(), doc);
  };
  await Promise.all([explicit(true), explicit(false)]);
});
