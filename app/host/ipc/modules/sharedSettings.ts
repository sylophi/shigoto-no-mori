import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import * as Effect from "effect/Effect";
import * as Views from "@host/lib/views";
import {
  sharedSettingsCopy,
  sharedSettingsLoaded,
} from "@host/lib/sharedSettings/store";

// Once the copy is read from the store.
const whenLoaded = <A>(f: () => A) =>
  Effect.andThen(sharedSettingsLoaded, Effect.sync(f));

export const sharedSettingsViews: ViewHandlers<
  typeof sharedSettingsContract,
  Views.Services
> = {
  // The app is the copy's one writer, and it holds the copy in memory
  // ahead of the store.
  watch: () =>
    Views.view(
      "sharedSettings:watch",
      () => whenLoaded(() => sharedSettingsCopy.read()),
      Views.pushed(sharedSettingsContract, "changed"),
    ),
};

export const sharedSettingsHandlers: EffectHandlers<
  typeof sharedSettingsContract,
  HandlerContext,
  never
> = {
  read: () => whenLoaded(() => sharedSettingsCopy.read()),
  set: ({ key, value }) => whenLoaded(() => sharedSettingsCopy.set(key, value)),
  merge: ({ doc }) => whenLoaded(() => sharedSettingsCopy.merge(doc)),
};
