import { clientSetting } from "@shigomori/contracts/schemas/config";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import {
  clientConfigChanges,
  patchClientConfig,
  readClientConfigSync,
} from "../../electron/clientConfig";
import { reconcileLaunchAtLogin } from "../../electron/liveness";

// Pure persistence on both sides. nativeTheme has one owner
// (applyThemeSource in electron/clientConfig.ts), fed by boot and the
// window module's previewTheme, never by a patch landing here.
export const clientConfigHandlers: Handlers<typeof clientConfigContract> = {
  read: () => readClientConfigSync(),
  patch: async ({ set, clear }) => {
    const { before, after } = await patchClientConfig(set, clear);
    // keepReachable rides this store but drives the OS login item, so
    // only a patch that changed it reconciles: unrelated ones (theme,
    // palettes) skip a redundant setLoginItemSettings syscall.
    if (
      clientSetting(after, "keepReachable") !==
      clientSetting(before, "keepReachable")
    ) {
      reconcileLaunchAtLogin();
    }
  },
};

export const clientConfigViews: ViewHandlers<
  typeof clientConfigContract,
  never
> = {
  watch: () => clientConfigChanges,
};
