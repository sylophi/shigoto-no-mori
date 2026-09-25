import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import type { Handlers } from "@shared/ipc/types";
import {
  DEVICE_SETTINGS_DEFAULTS,
  type DeviceSettingsPatch,
  type GlobalConfig,
} from "@shared/schemas";
import {
  invalidateGlobalConfigCache,
  readGlobalConfig,
  readGlobalConfigFresh,
  withGlobalConfigWriteLock,
} from "@host/lib/config/global";
import { invalidateTerrierCaches } from "@host/lib/terrier";
import { globalConfigWriteViaCli } from "../cliDelegate";

// A patched value equal to the key's default is stored by omission, so
// config.json stays tidy whichever device saved it. Values are plain
// JSON (booleans, string arrays, launcher objects), so their
// serializations compare them.
function isDefault(key: keyof DeviceSettingsPatch, value: unknown): boolean {
  return (
    JSON.stringify(value) === JSON.stringify(DEVICE_SETTINGS_DEFAULTS[key])
  );
}

export const globalConfigHandlers: Handlers<typeof globalConfigContract> = {
  read: async () => readGlobalConfig(),
  // The zod boundary already rejected any key outside the managed set
  // (the patch schema is strict), so by the time this runs the patch can
  // only carry settings the Settings form manages. Patch semantics:
  // read the stored document as the base, apply only the provided keys
  // (a value equal to its default deletes the key), and write the whole
  // document through the CLI. An explicitly-undefined key is skipped
  // rather than applied, or the write would delete the base's value.
  writeDeviceSettings: async ({ patch }) =>
    // Under the shared config write lock so two saves' read-modify-write
    // windows cannot interleave and lose an update.
    withGlobalConfigWriteLock(async () => {
      // Cache-bypassing base: the CLI clears every registered key the
      // payload omits, so a base up to the 5s TTL stale would write back
      // a value a CLI `set` just changed. The fresh read is what makes
      // the base authoritative for those registered keys.
      const doc: GlobalConfig = { ...(await readGlobalConfigFresh()) };
      for (const [name, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const key = name as keyof DeviceSettingsPatch;
        if (isDefault(key, value)) delete doc[key];
        else Object.assign(doc, { [key]: value });
      }
      await globalConfigWriteViaCli(doc);
      // The watcher treats the delegated spawn as a self-write, so the
      // TTL cache must be dropped here rather than by the fs event. This
      // fans out to the config-change subscribers too, so the direct
      // listener reconciles with the just-written document.
      invalidateGlobalConfigCache();
      // The terrier merge gates on the toggle just written. Without this
      // the sidebar would keep the pre-save project list for a TTL.
      invalidateTerrierCaches();
    }),
};
