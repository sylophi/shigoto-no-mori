import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import type { EffectHandlers, ViewHandlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import type * as DeviceId from "@host/lib/config/DeviceId";
import type * as Engine from "@host/lib/Engine";
import * as Views from "@host/lib/Views";
import * as SharedSettingsStore from "@host/lib/sharedSettings/store";

export const sharedSettingsViews: ViewHandlers<
  typeof sharedSettingsContract,
  Views.Services | Engine.Services
> = {
  watch: () =>
    Views.view(
      "sharedSettings:watch",
      () => SharedSettingsStore.read,
      Views.wrote("shared_settings"),
    ),
};

export const sharedSettingsHandlers: EffectHandlers<
  typeof sharedSettingsContract,
  HandlerContext,
  Engine.Services | DeviceId.DeviceId
> = {
  read: () => SharedSettingsStore.read,
  set: ({ key, value }) => SharedSettingsStore.set(key, value),
  merge: ({ doc }) => SharedSettingsStore.merge(doc),
};
