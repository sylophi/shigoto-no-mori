// This device's copy of the shared settings
// (packages/contracts/src/schemas/sharedSettings.ts), kept in the store
// (engine SharedSettings.ts), which a project edit is also stamped into
// (engine Config.ts). A change that changes nothing stores and announces
// nothing, which is what ends an exchange.
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import type {
  SharedSettingsDoc,
  SharedSettingValue,
} from "@shigomori/contracts/schemas/sharedSettings";
import {
  EMPTY_SHARED_SETTINGS,
  mergeSharedSettings,
  withSharedSetting,
} from "@shigomori/contracts/sharedSettings";
import * as SharedSettings from "@shigomori/engine/SharedSettings";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DeviceId from "../config/DeviceId";
import * as HostPushes from "../HostPushes";

export const read = Effect.flatMap(
  SharedSettings.SharedSettings,
  (settings) => settings.read,
);

const update = (next: (current: SharedSettingsDoc) => SharedSettingsDoc) =>
  Effect.flatMap(SharedSettings.SharedSettings, (settings) =>
    settings.update(next),
  );

export const set = Effect.fnUntraced(function* (
  key: string,
  value: SharedSettingValue,
) {
  const deviceId = yield* DeviceId.current;
  const now = yield* Clock.currentTimeMillis;
  const doc = yield* update((current) =>
    withSharedSetting(current, key, value, deviceId, now),
  );
  if (doc.entries[key]?.value !== value) {
    return yield* Effect.die(
      new Error("Shared settings are full on this device."),
    );
  }
  return doc;
});

export const merge = (incoming: SharedSettingsDoc) =>
  update((current) => mergeSharedSettings(current, incoming));

// For a device leaving the account. Not tombstones: those would
// outrank the peers' entries and clear the picks everywhere.
export const clear = update((current) =>
  Object.keys(current.entries).length === 0 ? current : EMPTY_SHARED_SETTINGS,
);

// Every commit to the shared settings, by any writer (a pick or a merge
// here, a project edit's stamps), to every window, which re-reads the copy
// off it, and every peer's, which folds it into its own.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const changes = yield* (yield* StoreChanges.StoreChanges).subscribe;
    yield* changes.pipe(
      Stream.filter((tables) => tables.has("shared_settings")),
      Stream.runForEach(() =>
        Effect.flatMap(read, (doc) =>
          HostPushes.push(sharedSettingsContract, "changed", doc),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
