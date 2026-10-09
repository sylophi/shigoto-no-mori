import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/views";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";

export const sharedSettingsViews: ViewHandlers<
  typeof sharedSettingsContract,
  Views.Services
> = {
  // The app is the copy's one writer, and it holds the copy in memory
  // ahead of the store.
  watch: () =>
    Views.view(
      () => sharedSettingsCopy.read(),
      Views.pushed(sharedSettingsContract, "changed"),
    ),
};

export const sharedSettingsHandlers: Handlers<typeof sharedSettingsContract> = {
  read: () => sharedSettingsCopy.read(),
  set: ({ key, value }) => sharedSettingsCopy.set(key, value),
  merge: ({ doc }) => sharedSettingsCopy.merge(doc),
};
