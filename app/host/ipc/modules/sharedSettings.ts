import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import type { Handlers } from "@shigomori/contracts/types";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";

export const sharedSettingsHandlers: Handlers<typeof sharedSettingsContract> = {
  read: () => sharedSettingsCopy.read(),
  set: ({ key, value }) => sharedSettingsCopy.set(key, value),
  merge: ({ doc }) => sharedSettingsCopy.merge(doc),
};
