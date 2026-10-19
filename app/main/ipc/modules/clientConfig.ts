import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import {
  clientConfigChanges,
  patchClientConfig,
  readClientConfigSync,
  rotatePalette,
} from "../../electron/clientConfig";

// Pure persistence on both sides. nativeTheme has one owner
// (applyThemeSource in electron/clientConfig.ts), fed by boot and the
// window module's previewTheme, never by a patch landing here.
export const clientConfigHandlers: Handlers<typeof clientConfigContract> = {
  read: () => readClientConfigSync(),
  patch: async ({ set, clear }) => {
    await patchClientConfig(set, clear);
  },
  rotate: ({ launching }) => rotatePalette(launching),
};

export const clientConfigViews: ViewHandlers<
  typeof clientConfigContract,
  never
> = {
  watch: () => clientConfigChanges,
};
