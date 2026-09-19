import { sharedSettingsContract } from "@shared/ipc/modules/sharedSettings";
import type { Handlers } from "@shared/ipc/types";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";

export const sharedSettingsHandlers: Handlers<typeof sharedSettingsContract> = {
  read: () => sharedSettingsCopy.read(),
  set: ({ key, value }) => sharedSettingsCopy.set(key, value),
  merge: ({ doc }) => sharedSettingsCopy.merge(doc),
};
