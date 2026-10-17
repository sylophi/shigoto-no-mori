import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/Views";
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
  writeDeviceSettings: ({ patch }) => Ops.patchGlobalConfig(patch),
} satisfies EffectHandlers<
  typeof globalConfigContract,
  unknown,
  Engine.Services
>;
