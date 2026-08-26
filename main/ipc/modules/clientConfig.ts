import { clientConfigContract } from "@shared/ipc/modules/clientConfig";
import type { Handlers } from "@shared/ipc/types";
import {
  readClientConfigSync,
  writeClientConfig,
} from "../../electron/clientConfig";

// Pure persistence on both sides. nativeTheme has one owner
// (applyThemeSource in electron/clientConfig.ts), fed by boot and the
// window module's previewTheme, never by a write landing here.
export const clientConfigHandlers: Handlers<typeof clientConfigContract> = {
  read: () => readClientConfigSync(),
  // Async so a save never blocks the main thread. Only the boot-path
  // read in electron/clientConfig.ts stays sync.
  write: async ({ config }) => {
    await writeClientConfig(config);
  },
};
