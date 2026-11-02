import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import type { EffectHandlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/Views";
import * as Terrier from "@shigomori/engine/Terrier";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/Engine";
import * as EngineConfig from "@shigomori/engine/Config";

export const globalConfigViews: ViewHandlers<
  typeof globalConfigContract,
  Views.Services | Engine.Services
> = {
  watch: () =>
    Views.view(
      "globalConfig:watch",
      () => Effect.flatMap(EngineConfig.Config, (config) => config.readDevice),
      Views.wrote("device_config"),
    ),
};

export const globalConfigHandlers = {
  // The device's settings as stored (`sm config read`).
  read: () =>
    Effect.flatMap(EngineConfig.Config, (config) => config.readDevice),
  // The patch schema is strict, so only the settings the form manages
  // arrive.
  writeDeviceSettings: ({ patch }) =>
    Effect.flatMap(EngineConfig.Config, (config) => config.patch(patch)).pipe(
      // At once as well as on the store's tick (followDeviceSettings), so
      // the form's next readiness read after a terrier toggle reads anew.
      Effect.andThen(Effect.flatMap(Terrier.Terrier, (it) => it.invalidate)),
    ),
} satisfies EffectHandlers<
  typeof globalConfigContract,
  unknown,
  Terrier.Terrier | Engine.Services
>;
