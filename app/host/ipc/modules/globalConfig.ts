import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Views from "@host/lib/views";
import {
  DEVICE_SETTINGS_DEFAULTS,
  type DeviceSettingsPatch,
} from "@shigomori/contracts/schemas";
import {
  globalConfigChanged,
  globalConfigWrites,
} from "@host/lib/config/global";
import * as Terrier from "@host/lib/terrier";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";
import type { ClearingWrite } from "@host/lib/engineOps";

// A patched value equal to the key's default is stored by omission, so
// stored settings stay tidy whichever device saved them. Values are plain
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
  Views.Services | Engine.Services
> = {
  watch: () =>
    Views.view(
      "globalConfig:watch",
      () => Ops.readGlobalConfig(),
      Views.wrote("device_config"),
    ),
};

export const globalConfigHandlers = {
  // The device's settings as stored (`sm config read`).
  read: () => Ops.readGlobalConfig(),
  // The schema boundary already rejected any key outside the managed set
  // (the patch schema is strict), so by the time this runs the patch can
  // only carry settings the Settings form manages. Patch semantics:
  // read the stored managed settings as the base, apply only the
  // provided keys (a value equal to its default deletes the key), and
  // write those settings through the engine. An explicitly-undefined
  // key is skipped rather than applied, or the write would delete the
  // base's value.
  writeDeviceSettings: ({ patch }) =>
    Effect.gen(function* () {
      // Under the shared config write lock so two saves' read-modify-write
      // windows cannot interleave and lose an update.
      yield* Effect.gen(function* () {
        // The write clears every registered key the payload omits, so
        // the base is read fresh, which makes it authoritative for those
        // keys. Only the managed settings ride in the payload, so a key
        // this build doesn't model never does, and the merge keeps it as
        // stored.
        const stored = yield* Ops.readGlobalConfig();
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
        yield* Ops.writeGlobalConfig(doc);
        // The config-change subscribers hear it here, at once: the direct
        // listener reconciles with the just-written document.
        globalConfigChanged();
      }).pipe(globalConfigWrites.withPermits(1));
      // The terrier toggle may have flipped: re-probe its readiness on
      // the next ask. (The merge itself is the engine's, read fresh on
      // every project list.)
      yield* Effect.flatMap(Terrier.Terrier, (it) => it.invalidate);
    }),
} satisfies EffectHandlers<
  typeof globalConfigContract,
  unknown,
  Terrier.Terrier | Engine.Services
>;
