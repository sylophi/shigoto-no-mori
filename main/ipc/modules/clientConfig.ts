import { clientConfigContract } from "@shared/ipc/modules/clientConfig";
import type { Handlers } from "@shared/ipc/types";
import {
  readClientConfigSync,
  writeClientConfig,
} from "../../electron/clientConfig";
import { reconcileLaunchAtLogin } from "../../electron/liveness";

// Pure persistence on both sides. nativeTheme has one owner
// (applyThemeSource in electron/clientConfig.ts), fed by boot and the
// window module's previewTheme, never by a write landing here.
export const clientConfigHandlers: Handlers<typeof clientConfigContract> = {
  read: () => readClientConfigSync(),
  // Async so a save never blocks the main thread. Only the boot-path
  // read in electron/clientConfig.ts stays sync.
  write: async ({ config }) => {
    // keepReachable rides this store but drives the OS login item, so
    // capture the prior persisted value before the write and reconcile
    // only when it actually changed. Unrelated writes (theme, doubutsu)
    // then skip a redundant setLoginItemSettings syscall. reconcile is
    // still idempotent and never-throws, so gating is purely an
    // optimization, not a correctness requirement.
    const priorKeepReachable = readClientConfigSync().keepReachable === true;
    await writeClientConfig(config);
    if ((config.keepReachable === true) !== priorKeepReachable) {
      reconcileLaunchAtLogin();
    }
  },
};
