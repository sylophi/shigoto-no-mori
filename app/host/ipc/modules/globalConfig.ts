import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/Views";
import * as Terrier from "@shigomori/engine/Terrier";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/Engine";
import * as Ops from "@host/lib/engineOps";

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
  // The patch schema is strict, so only the settings the form manages
  // arrive.
  writeDeviceSettings: ({ patch }) =>
    Ops.patchGlobalConfig(patch).pipe(
      // At once as well as on the store's tick (followDeviceSettings), so
      // the form's next readiness read after a terrier toggle reads anew.
      Effect.andThen(Effect.flatMap(Terrier.Terrier, (it) => it.invalidate)),
    ),
} satisfies EffectHandlers<
  typeof globalConfigContract,
  unknown,
  Terrier.Terrier | Engine.Services
>;
