import { homedir } from "node:os";
import { basename } from "node:path";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import type { Handlers } from "@shared/ipc/types";
import type { NukeProgress } from "@shared/schemas";
import { nukeEverything } from "@host/lib/nuke";
import { moveShigomoriRoot } from "@host/lib/rootMove";
import { shigomoriRoot } from "@host/lib/util/paths";

// The electron layer injects the app-lifecycle teardown hooks at boot:
// CLI uninstall, the watcher and updater-bridge stops, and the
// nuke-progress fan-out (which rides the Electron transport binding).
// Keeping them behind a setter keeps this handler module free of
// Electron imports.
type RuntimeImpl = {
  uninstallCliEverything: () => Promise<void>;
  stopStateWatcher: () => void;
  stopUpdaterBridge: () => void;
  broadcastNukeProgress: (progress: NukeProgress) => void;
};

let impl: RuntimeImpl | null = null;

export function setRuntimeImpl(next: RuntimeImpl): void {
  impl = next;
}

function runtimeImpl(): RuntimeImpl {
  if (impl === null) {
    throw new Error(
      "runtime handler invoked before setRuntimeImpl registered one",
    );
  }
  return impl;
}

export const runtimeHandlers: Handlers<typeof runtimeContract> = {
  // Host facts only. isDev deliberately isn't here: it describes the
  // client build and rides the preload bridge (api.isDev) instead.
  info: () => ({
    shigomoriRoot: shigomoriRoot(),
    rootDirName: basename(shigomoriRoot()),
    homedir: homedir(),
  }),

  moveRoot: async ({ parentDir }) => {
    await moveShigomoriRoot(parentDir, {
      beforeMove: () => {
        runtimeImpl().stopStateWatcher();
        runtimeImpl().stopUpdaterBridge();
      },
    });
    // The root is a boot-time constant (initShigomoriRoot's one-shot
    // guard exists precisely so it can't change under live callers).
    // The renderer calls the window module's `relaunch` once this
    // reply lands.
  },

  nuke: async () => {
    await nukeEverything((progress) =>
      runtimeImpl().broadcastNukeProgress(progress),
    );
    // Nuke means "remove everything shigomori put on this machine";
    // the CLI links and the shell-integration hooks are part of that.
    // Settings offers a fresh install afterwards.
    await runtimeImpl().uninstallCliEverything();
  },
};
