import { homedir } from "node:os";
import { resolve } from "node:path";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { NukeProgress } from "@shared/schemas";
import { nukeEverything } from "@host/lib/nuke";
import { moveDataDir } from "@host/lib/dataDirMove";
import { implSlot } from "@host/lib/util/implSlot";
import {
  canonicalDataDirName,
  dataDir,
  dataDirSource,
  defaultDataDir,
} from "@host/lib/util/paths";

// The electron layer injects the app-lifecycle teardown hooks at boot:
// CLI uninstall, the watcher and updater-bridge stops, and the
// nuke-progress fan-out (which rides the Electron transport binding).
// Keeping them behind a setter keeps this handler module free of
// Electron imports.
type RuntimeImpl = {
  uninstallCliEverything: () => Promise<void>;
  stopStateWatcher: () => void;
  stopUpdaterBridge: () => void;
  // Unpublishes control.json, so the moved data dir never carries the
  // address of this pre-move process to a CLI that resolved the new one.
  stopControlHost: () => void;
  broadcastNukeProgress: (progress: NukeProgress) => void;
  // The data dir was wiped and reseeded under the running app: put back
  // the plumbing files this process keeps there.
  afterDataWipe: () => void;
  relaunchAppUnattended: () => void;
  // Why a move asked for by another device must not start right now
  // (it reaps every running script, and nobody here was asked), or
  // null when the host is idle.
  unattendedMoveRefusal: () => string | null;
};

const { set: setRuntimeImpl, get: runtimeImpl } = implSlot<RuntimeImpl>(
  "runtime handler invoked before setRuntimeImpl registered one",
);
export { setRuntimeImpl };

let moveInFlight = false;

export const runtimeHandlers: Handlers<typeof runtimeContract, HandlerContext> =
  {
    // Host facts only. isDev deliberately isn't here: it describes the
    // client build and rides the preload bridge (api.isDev) instead.
    info: () => ({
      dataDir: dataDir(),
      dataDirSource: dataDirSource(),
      // resolve() drops the trailing slash a hand-edited pointer may carry.
      atDefaultDataDir: resolve(dataDir()) === defaultDataDir(),
      canonicalDataDirName: canonicalDataDirName(),
      homedir: homedir(),
    }),

    moveDataDir: async ({ parentDir }, ctx) => {
      const unattended = isRemoteCaller(ctx);
      // One move at a time, now that the local window is no longer the
      // only caller: two would share the staged pointer file and undo
      // each other's re-key.
      if (moveInFlight) {
        throw new Error("The data folder is already being moved.");
      }
      if (unattended) {
        const refusal = runtimeImpl().unattendedMoveRefusal();
        if (refusal !== null) throw new Error(refusal);
      }
      moveInFlight = true;
      let watchersStopped = false;
      try {
        await moveDataDir(parentDir, {
          beforeMove: () => {
            watchersStopped = true;
            runtimeImpl().stopStateWatcher();
            runtimeImpl().stopUpdaterBridge();
            runtimeImpl().stopControlHost();
          },
        });
      } catch (err) {
        // A move that failed after the watchers stopped leaves this
        // app running without them. At this machine the user sees the
        // error and can restart. For a peer's move nobody here does,
        // so the restart that brings them back happens anyway (the
        // data dir and pointer are where they were).
        if (unattended && watchersStopped) {
          runtimeImpl().relaunchAppUnattended();
        } else {
          moveInFlight = false;
        }
        throw err;
      }
      // The latch stays set from here: the data dir is a boot-time
      // constant (initDataDir's one-shot guard exists precisely so it
      // can't change under live callers), so until the restart this
      // process still names the old folder and must not move it again.
      // The local renderer calls the window module's `relaunch` once
      // this reply lands. A peer has no window module on this machine
      // to acknowledge with, so the host relaunches itself, after the
      // reply has left (the electron layer owns that timing).
      if (unattended) runtimeImpl().relaunchAppUnattended();
    },

    nuke: async () => {
      try {
        await nukeEverything((progress) =>
          runtimeImpl().broadcastNukeProgress(progress),
        );
      } finally {
        // A wipe that failed past the rm still took the files along.
        runtimeImpl().afterDataWipe();
      }
      // Nuke means "remove everything shigomori put on this machine";
      // the CLI links and the shell-integration hooks are part of that.
      // Settings offers a fresh install afterwards.
      await runtimeImpl().uninstallCliEverything();
    },
  };
