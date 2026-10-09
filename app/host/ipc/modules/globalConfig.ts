import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/views";
import {
  DEVICE_SETTINGS_DEFAULTS,
  type DeviceSettingsPatch,
} from "@shigomori/contracts/schemas";
import {
  globalConfigChanged,
  readGlobalConfig,
  withGlobalConfigWriteLock,
} from "@host/lib/config/global";
import { invalidateTerrierReadiness } from "@host/lib/terrier";
import { type ClearingWrite, writeGlobalConfig } from "@host/lib/engineCalls";

// A patched value equal to the key's default is stored by omission, so
// config.json stays tidy whichever device saved it. Values are plain
// JSON (booleans, string arrays, launcher objects), so their
// serializations compare them.
function isDefault(key: keyof DeviceSettingsPatch, value: unknown): boolean {
  return (
    JSON.stringify(value) === JSON.stringify(DEVICE_SETTINGS_DEFAULTS[key])
  );
}

const MANAGED_KEYS = Object.keys(
  DEVICE_SETTINGS_DEFAULTS,
) as (keyof DeviceSettingsPatch)[];

export const globalConfigViews: ViewHandlers<
  typeof globalConfigContract,
  Views.Services
> = {
  watch: () => Views.view(readGlobalConfig, Views.wrote("device_config")),
};

export const globalConfigHandlers: Handlers<typeof globalConfigContract> = {
  // config.json as stored, read through the CLI (`sm config read`) and
  // cached for a few seconds (host/lib/config/global.ts).
  read: async () => readGlobalConfig(),
  // The zod boundary already rejected any key outside the managed set
  // (the patch schema is strict), so by the time this runs the patch can
  // only carry settings the Settings form manages. Patch semantics:
  // read the stored managed settings as the base, apply only the
  // provided keys (a value equal to its default deletes the key), and
  // write those settings through the CLI. An explicitly-undefined key is
  // skipped rather than applied, or the write would delete the base's
  // value.
  writeDeviceSettings: async ({ patch }) =>
    // Under the shared config write lock so two saves' read-modify-write
    // windows cannot interleave and lose an update.
    withGlobalConfigWriteLock(async () => {
      // The write clears every registered key the payload omits, so
      // the base is read fresh, which makes it authoritative for those
      // keys. Only the managed settings ride in the payload, so a key
      // this build doesn't model never does, and the merge keeps it as
      // stored.
      const stored = await readGlobalConfig();
      const doc: ClearingWrite<DeviceSettingsPatch> = {};
      for (const key of MANAGED_KEYS) {
        if (stored[key] !== undefined)
          Object.assign(doc, { [key]: stored[key] });
      }
      for (const [name, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const key = name as keyof DeviceSettingsPatch;
        // Null, not omitted, so the write clears it registered or not.
        if (isDefault(key, value)) doc[key] = null;
        else Object.assign(doc, { [key]: value });
      }
      await writeGlobalConfig(doc);
      // The store watcher doesn't see the app's own writes, so the
      // config-change subscribers hear it here: the direct listener
      // reconciles with the just-written document.
      globalConfigChanged();
      // The terrier toggle may have flipped: re-probe its readiness on
      // the next ask. (The merge itself is the CLI's, read fresh on
      // every project list.)
      await invalidateTerrierReadiness();
    }),
};
