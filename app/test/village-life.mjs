// Durable proof for the Village life setting, and that the app and the
// CLI read it the same way. It is a device setting in config.json
// beside Doubutsu names, read by the app alone: the renderer gates
// villager extras on villageLifeEnabled (shared/villageLife.ts, read
// through useVillageLife), and the CLI only registers the key so a
// whole-document save can clear it.
//
// Asserts:
// - unset Village life reads as off, and a fresh install does not seed it
// - Village life counts only while Doubutsu names is on
// - the Settings form shows Village life's stored value even with names
//   off
// - the remote patch carries it
// - against the REAL sm binary, the form's save lands through the CLI's
//   whole-document write (as the host's writeDeviceSettings applies a
//   patch) and both engines read identical values
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
  DEVICE_SETTINGS_DEFAULTS,
  DeviceSettingsPatchSchema,
} from "@shared/schemas";
import { doubutsuNamesEnabled, villageLifeEnabled } from "@shared/villageLife";
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
  await proof.check("unset names and unset Village life read off", () => {
    const cases = [
      [{}, false, false],
      [{ villageLife: true }, false, false],
      [{ doubutsuNames: true }, true, false],
      [{ doubutsuNames: true, villageLife: true }, true, true],
      [{ doubutsuNames: true, villageLife: false }, true, false],
      [{ doubutsuNames: false }, false, false],
      [FRESH_CONFIG_SEED, true, false],
    ];
    for (const [config, names, village] of cases) {
      const label = JSON.stringify(config);
      assert.equal(doubutsuNamesEnabled(config), names, label);
      assert.equal(villageLifeEnabled(config), village, label);
    }
  });

  await proof.check("the form shows Village life's stored value", () => {
    const unset = fromConfig({}, {});
    assert.equal(unset.doubutsuNames, false);
    assert.equal(unset.villageLife, false);
    const seeded = fromConfig(FRESH_CONFIG_SEED, {});
    assert.equal(seeded.doubutsuNames, true);
    assert.equal(seeded.villageLife, false);
    // Names off disables the row but keeps what it holds.
    assert.equal(fromConfig({ villageLife: true }, {}).villageLife, true);
  });

  await proof.check("the remote patch carries Village life", () => {
    const patch = toDeviceSettingsPatch({
      ...fromConfig({}, {}),
      villageLife: true,
    });
    assert.equal(patch.villageLife, true);
    assert.ok(DeviceSettingsPatchSchema.safeParse(patch).success);
  });

  await execFileP("go", ["build", "-o", smBinary, "."], {
    cwd: join(repoRoot, "cli"),
  });

  await proof.check(
    "saves through the CLI read the same in both engines",
    async () => {
      // A fresh install, seeded by the CLI: names on, Village life off.
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
        const [names, village] = await Promise.all([
          read("doubutsuNames"),
          read("villageLife"),
        ]);
        return { doubutsuNames: names, villageLife: village };
      };
      // The Settings save: the form's patch applied over the stored
      // document the way the host's writeDeviceSettings does (a value
      // equal to its default deletes the key), then the CLI's
      // whole-document write.
      const save = async (patch) => {
        const state = { ...fromConfig(config(), {}), ...patch };
        const doc = { ...config() };
        for (const [key, value] of Object.entries(
          toDeviceSettingsPatch(state),
        )) {
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
      const villageDefault = { value: false, set: false };

      assert.deepEqual(await get(), {
        doubutsuNames: namesOn,
        villageLife: villageDefault,
      });
      assert.equal(villageLifeEnabled(config()), false);

      // Turning it on stores true.
      await save({ villageLife: true });
      assert.equal(config().villageLife, true);
      assert.deepEqual(await get(), {
        doubutsuNames: namesOn,
        villageLife: { value: true, set: true },
      });
      assert.equal(villageLifeEnabled(config()), true);

      // Names off gates it without touching what it holds.
      await save({ doubutsuNames: false });
      assert.ok(!("doubutsuNames" in config()), "names off is stored");
      assert.equal(config().villageLife, true);
      assert.equal(fromConfig(config(), {}).villageLife, true);
      assert.equal(villageLifeEnabled(config()), false);

      // Back on, then Village life off returns it to the default.
      await save({ doubutsuNames: true, villageLife: false });
      assert.equal(config().doubutsuNames, true);
      assert.ok(!("villageLife" in config()), "villageLife still stored");
      assert.deepEqual(await get(), {
        doubutsuNames: namesOn,
        villageLife: villageDefault,
      });

      await sm("config", "set", "villageLife", "on");
      assert.equal(fromConfig(config(), {}).villageLife, true);
      assert.equal(villageLifeEnabled(config()), true);
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
