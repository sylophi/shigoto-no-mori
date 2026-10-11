import { homedir } from "node:os";
import { resolve } from "node:path";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { uninstallCliEverything } from "@host/lib/cli/install";
import * as Ops from "@host/lib/engineOps";
import { leftIf, nukeEverything } from "@host/lib/nuke";
import * as Terminals from "@host/lib/terminals/Terminals";
import { moveDataDir } from "@host/lib/dataDirMove";
import { getBusyOperations, killAllScripts } from "@host/lib/scripts";
import { busyRemoteRefusal } from "@shared/busy";
import { DataDirHolders } from "@host/lib/DataDirHolders";
import * as HostPushes from "@host/lib/hostPushes";
import * as Shell from "@host/lib/Shell";
import type { HostServices } from "@host/process/services";
import {
  canonicalDataDirName,
  dataDir,
  dataDirSource,
  defaultDataDir,
} from "@host/lib/util/paths";

class MoveRefusedError extends Schema.TaggedError<MoveRefusedError>()(
  "MoveRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

let moveInFlight = false;

export const runtimeHandlers = {
  // Host facts only. isDev deliberately isn't here: it describes the
  // client build and rides the preload bridge (api.isDev) instead.
  info: () =>
    Effect.sync(() => ({
      dataDir: dataDir(),
      dataDirSource: dataDirSource(),
      // resolve() drops the trailing slash a hand-edited pointer may carry.
      atDefaultDataDir: resolve(dataDir()) === defaultDataDir(),
      canonicalDataDirName: canonicalDataDirName(),
      homedir: homedir(),
    })),

  moveDataDir: ({ parentDir }, ctx) =>
    Effect.gen(function* () {
      const unattended = isRemoteCaller(ctx);
      const shell = yield* Shell.Shell;
      const holders = yield* DataDirHolders;
      // One move at a time, now that the local window is no longer the
      // only caller: two would share the staged pointer file and undo
      // each other's re-key.
      if (moveInFlight) {
        return yield* new MoveRefusedError({
          reason: "The data folder is already being moved.",
        });
      }
      if (unattended) {
        // It reaps every running script, and nobody here was asked.
        const refusal = busyRemoteRefusal(getBusyOperations(), "move");
        if (refusal !== null) {
          return yield* new MoveRefusedError({ reason: refusal });
        }
      }
      moveInFlight = true;
      let watchersStopped = false;
      yield* moveDataDir(parentDir, {
        killAllScripts: killAllScripts(),
        beforeMove: Effect.suspend(() => {
          watchersStopped = true;
          return holders.release;
        }),
      }).pipe(
        Effect.onError(() =>
          Effect.suspend(() => {
            // A move that failed after the watchers stopped leaves this
            // app running without them. At this machine the user sees
            // the error and can restart. For a peer's move nobody here
            // does, so the restart that brings them back happens anyway
            // (the data dir and pointer are where they were).
            if (unattended && watchersStopped) return shell.relaunch;
            moveInFlight = false;
            return Effect.void;
          }),
        ),
      );
      // The latch stays set from here: the data dir is a boot-time
      // constant (initDataDir's one-shot guard exists precisely so it
      // can't change under live callers), so until the restart this
      // process still names the old folder and must not move it again.
      // The local renderer calls the window module's `relaunch` once
      // this reply lands. A peer has no window module on this machine
      // to acknowledge with, so the host relaunches itself, after the
      // reply has left (the shell owns that timing).
      if (unattended) yield* shell.relaunch;
    }),

  nuke: () =>
    Effect.flatMap(Terminals.Terminals, (terminals) =>
      nukeEverything({
        onProgress: (progress) =>
          HostPushes.push(runtimeContract, "nukeProgress", progress),
        killAllScripts: killAllScripts(),
        closeTerminals: terminals.closeEvery,
        uninstall: Effect.map(
          Effect.all([
            leftIf(
              "The terminal command and its shell hooks",
              uninstallCliEverything,
            ),
            leftIf("The agent hooks", Ops.removeAllAgentHooks),
          ]),
          (lists) => lists.flat(),
        ),
      }),
    ),
} satisfies EffectHandlers<
  typeof runtimeContract,
  HandlerContext,
  HostServices
>;
