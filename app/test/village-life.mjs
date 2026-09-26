// Durable proof for Village life and Prioritize birthdays, the two
// halves of what was one device setting. Village life is a client
// setting (ClientConfig): the renderer gates villager extras on
// villageLifeShows (shared/villageLife.ts, read through useVillageLife),
// and no device reads it. prioritizeBirthdays lives in config.json
// beside Doubutsu names: the CLI registers the key so a whole-document
// save can clear it, and reads it to invite a birthday villager
// (cli/birthdays.go).
//
// Asserts:
// - unset, both read as off, a fresh install seeds neither, and
//   Prioritize birthdays counts only while Doubutsu names is on
// - Village life shows only with the villager data downloaded
// - the Settings form shows each one's stored value, and Prioritize
//   birthdays' even with names off
// - the device patch carries Prioritize birthdays and never Village life
// - against the REAL sm binary, prioritizeBirthdays is off when unset
//   and not seeded, a device-settings save of it lands through the
//   CLI's whole-document write (as the host's writeDeviceSettings
//   applies a patch), turning names off leaves it stored, and both
//   engines read identical values
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test village-life.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FRESH_CONFIG_SEED } from "@host/lib/bootstrap";
import {
  ClientConfigSchema,
  DEVICE_SETTINGS_DEFAULTS,
  DeviceSettingsPatchSchema,
} from "@shared/schemas";
import {
  doubutsuNamesEnabled,
  prioritizeBirthdaysEnabled,
  villageLifeEnabled,
  villageLifeShows,
} from "@shared/villageLife";
import { createCliRunner, makeProof, repoRoot } from "./lib/checkKit.mjs";

// The settings encoders sit beside their React hook, whose imports read
// window.api.deviceId at load. Nothing here calls into window, so a
// bare stand-in is enough to load them under node.
globalThis.window = { api: { deviceId: "village-life-check" } };
const { fromConfig, toDeviceSettingsPatch } =
  await import("@/hooks/config/useSettingsSave");

const execFileP = promisify(execFile);
const proof = makeProof("village-life proof");
console.log("village-life proof\n");

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-village-check-")));
const smBinary = join(sandbox, "sm");

try {
  await proof.check("unset, each setting reads off", () => {
    const cases = [
      [{}, false, false],
      [{ prioritizeBirthdays: true }, false, false],
      [{ doubutsuNames: true }, true, false],
      [{ doubutsuNames: true, prioritizeBirthdays: true }, true, true],
      [{ doubutsuNames: true, prioritizeBirthdays: false }, true, false],
      [{ doubutsuNames: false }, false, false],
      [FRESH_CONFIG_SEED, true, false],
    ];
    for (const [config, names, birthdays] of cases) {
      const label = JSON.stringify(config);
      assert.equal(doubutsuNamesEnabled(config), names, label);
      assert.equal(prioritizeBirthdaysEnabled(config), birthdays, label);
    }
    assert.equal(villageLifeEnabled({}), false);
    assert.equal(villageLifeEnabled({ villageLife: false }), false);
    assert.equal(villageLifeEnabled({ villageLife: true }), true);
  });

  await proof.check("Village life shows only with the villager data", () => {
    const on = { villageLife: true };
    assert.equal(villageLifeShows(on, { kind: "ready" }), true);
    for (const status of [
      undefined,
      { kind: "absent" },
      { kind: "downloading" },
      { kind: "failed" },
    ]) {
      assert.equal(villageLifeShows(on, status), false, status?.kind);
    }
    assert.equal(villageLifeShows({}, { kind: "ready" }), false);
  });

  await proof.check("the form shows each stored value", () => {
    const unset = fromConfig({}, {});
    assert.equal(unset.doubutsuNames, false);
    assert.equal(unset.prioritizeBirthdays, false);
    assert.equal(unset.villageLife, false);
    const seeded = fromConfig(FRESH_CONFIG_SEED, {});
    assert.equal(seeded.doubutsuNames, true);
    assert.equal(seeded.prioritizeBirthdays, false);
    assert.equal(fromConfig({}, { villageLife: true }).villageLife, true);
    // Names off disables the row but keeps what it holds.
    assert.equal(
      fromConfig({ prioritizeBirthdays: true }, {}).prioritizeBirthdays,
      true,
    );
  });

  await proof.check(
    "the device patch carries Prioritize birthdays, never Village life",
    () => {
      const patch = toDeviceSettingsPatch({
        ...fromConfig({}, {}),
        villageLife: true,
        prioritizeBirthdays: true,
      });
      assert.equal(patch.prioritizeBirthdays, true);
      assert.ok(!("villageLife" in patch));
      assert.ok(DeviceSettingsPatchSchema.safeParse(patch).success);
      assert.ok(
        !DeviceSettingsPatchSchema.safeParse({ villageLife: true }).success,
      );
      assert.equal(
        ClientConfigSchema.parse({ villageLife: true }).villageLife,
        true,
      );
    },
  );

  await execFileP("go", ["build", "-o", smBinary, "."], {
    cwd: join(repoRoot, "cli"),
  });

  await proof.check(
    "prioritizeBirthdays saves through the CLI and reads the same in both engines",
    async () => {
      // A fresh install, seeded by the CLI: names on, the invite off.
      const dir = join(sandbox, "data");
      mkdirSync(dir);
      const { sm } = createCliRunner(smBinary, {
        ...process.env,
        HOME: sandbox,
        SHIGOMORI_DATA_DIR: dir,
      });
      const config = () =>
        JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      // What the CLI reports for both keys: each one's effective value
      // and whether the file holds it.
      const get = async () => {
        const read = async (key) => {
          const { docs } = await sm("config", "get", key);
          const doc = docs.findLast((d) => d.ok === true);
          return { value: doc.value, set: doc.set };
        };
        const [names, birthdays] = await Promise.all([
          read("doubutsuNames"),
          read("prioritizeBirthdays"),
        ]);
        return { doubutsuNames: names, prioritizeBirthdays: birthdays };
      };
      // A device-settings save: the patch applied over the stored
      // document the way the host's writeDeviceSettings does (a value
      // equal to its default deletes the key), then the CLI's
      // whole-document write.
      const save = async (patch) => {
        assert.ok(DeviceSettingsPatchSchema.safeParse(patch).success);
        const doc = { ...config() };
        for (const [key, value] of Object.entries(patch)) {
          if (
            JSON.stringify(value) ===
            JSON.stringify(DEVICE_SETTINGS_DEFAULTS[key])
          ) {
            delete doc[key];
          } else {
            doc[key] = value;
          }
        }
        await sm("config", "write", "--data", JSON.stringify(doc));
      };
      const namesOn = { value: true, set: true };
      const birthdaysDefault = { value: false, set: false };

      assert.equal(DEVICE_SETTINGS_DEFAULTS.prioritizeBirthdays, false);
      assert.deepEqual(await get(), {
        doubutsuNames: namesOn,
        prioritizeBirthdays: birthdaysDefault,
      });

      // Turning it on stores true.
      await save({ prioritizeBirthdays: true });
      assert.equal(config().prioritizeBirthdays, true);
      assert.deepEqual(await get(), {
        doubutsuNames: namesOn,
        prioritizeBirthdays: { value: true, set: true },
      });

      // Names off gates it without touching what it holds.
      await save({ doubutsuNames: false });
      assert.ok(!("doubutsuNames" in config()), "names off is stored");
      assert.equal(config().prioritizeBirthdays, true);

      // Back on, then the invite off returns it to the default.
      await save({ doubutsuNames: true, prioritizeBirthdays: false });
      assert.equal(config().doubutsuNames, true);
      assert.ok(
        !("prioritizeBirthdays" in config()),
        "prioritizeBirthdays still stored",
      );
      assert.deepEqual(await get(), {
        doubutsuNames: namesOn,
        prioritizeBirthdays: birthdaysDefault,
      });

      await sm("config", "set", "prioritizeBirthdays", "on");
      assert.equal(config().prioritizeBirthdays, true);
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
