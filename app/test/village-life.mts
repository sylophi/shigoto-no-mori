// Durable proof for Village life, a client setting (ClientConfig): the
// renderer gates villager extras on villageLifeShows
// (shared/villageLife.ts, read through useVillageLife), and no device
// reads it. Doubutsu names, the device setting beside it in config.json,
// is proven through the real sm binary by fresh-install.
//
// Asserts:
// - unset, Village life and Doubutsu names read as off, and a fresh
//   install seeds names alone
// - unset, Village news reads as on, and only off is stored
// - Village life shows only with the villager data downloaded
// - the Settings form shows each one's stored value
// - the device patch never carries Village life
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test village-life.
import assert from "node:assert/strict";
import { FRESH_CONFIG_SEED } from "@host/lib/bootstrap";
import { ClientConfigSchema, DeviceSettingsPatchSchema } from "@shared/schemas";
import type { VillagerDataStatus } from "@shared/schemas/villagers";
import {
  doubutsuNamesEnabled,
  villageLifeEnabled,
  villageLifeShows,
  villageNewsEnabled,
} from "@shared/villageLife";
import { makeProof } from "./lib/checkKit.mts";

// The settings encoders sit beside their React hook, whose imports read
// window.api.deviceId at load. Nothing here calls into window, so a
// bare stand-in is enough to load them under node.
// @ts-expect-error a bare stand-in, not the whole preload api
globalThis.window = { api: { deviceId: "village-life-check" } };
const { fromConfig, toClientConfig, toDeviceSettingsPatch } =
  await import("@/hooks/config/useSettingsSave");

const proof = makeProof("village-life proof");
console.log("village-life proof\n");

try {
  await proof.check("unset, each setting reads off", () => {
    assert.equal(doubutsuNamesEnabled({}), false);
    assert.equal(doubutsuNamesEnabled({ doubutsuNames: false }), false);
    assert.equal(doubutsuNamesEnabled({ doubutsuNames: true }), true);
    assert.equal(doubutsuNamesEnabled(FRESH_CONFIG_SEED), true);
    assert.equal(villageLifeEnabled({}), false);
    assert.equal(villageLifeEnabled({ villageLife: false }), false);
    assert.equal(villageLifeEnabled({ villageLife: true }), true);
  });

  await proof.check("unset, Village news reads on", () => {
    assert.equal(villageNewsEnabled({}), true);
    assert.equal(villageNewsEnabled({ villageNews: true }), true);
    assert.equal(villageNewsEnabled({ villageNews: false }), false);
  });

  await proof.check("Village life shows only with the villager data", () => {
    const on = { villageLife: true };
    assert.equal(villageLifeShows(on, { kind: "ready" }), true);
    const statuses: (Pick<VillagerDataStatus, "kind"> | undefined)[] = [
      undefined,
      { kind: "absent" },
      { kind: "downloading" },
      { kind: "failed" },
    ];
    for (const status of statuses) {
      assert.equal(villageLifeShows(on, status), false, status?.kind);
    }
    assert.equal(villageLifeShows({}, { kind: "ready" }), false);
  });

  await proof.check("the form shows each stored value", () => {
    const unset = fromConfig({}, {});
    assert.equal(unset.doubutsuNames, false);
    assert.equal(unset.villageLife, false);
    const seeded = fromConfig(FRESH_CONFIG_SEED, {});
    assert.equal(seeded.doubutsuNames, true);
    assert.equal(fromConfig({}, { villageLife: true }).villageLife, true);
    assert.equal(unset.villageNews, true);
    assert.equal(fromConfig({}, { villageNews: false }).villageNews, false);
  });

  await proof.check("Village news is stored only when off", () => {
    const on = fromConfig({}, {});
    assert.equal(toClientConfig(on).villageNews, undefined);
    const off = toClientConfig({ ...on, villageNews: false });
    assert.equal(off.villageNews, false);
    assert.equal(fromConfig({}, off).villageNews, false);
  });

  await proof.check("the device patch never carries Village life", () => {
    const patch = toDeviceSettingsPatch({
      ...fromConfig({}, {}),
      villageLife: true,
    });
    assert.ok(!("villageLife" in patch));
    assert.ok(DeviceSettingsPatchSchema.safeParse(patch).success);
    assert.ok(
      !DeviceSettingsPatchSchema.safeParse({ villageLife: true }).success,
    );
    assert.equal(
      ClientConfigSchema.parse({ villageLife: true }).villageLife,
      true,
    );
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
