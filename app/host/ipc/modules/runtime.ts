import { homedir } from "node:os";
import { resolve } from "node:path";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { NukeProgress } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { uninstallCliEverything } from "@host/lib/cli/install";
import { nukeEverything } from "@host/lib/nuke";
import { moveDataDir } from "@host/lib/dataDirMove";
import { killAllScripts } from "@host/lib/scripts";
import { implSlot } from "@host/lib/util/implSlot";
import type { HostServices } from "@host/process/services";
import {
  canonicalDataDirName,
  dataDir,
  dataDirSource,
  defaultDataDir,
} from "@host/lib/util/paths";

// The host's root injects the app-lifecycle teardown hooks at boot
// (process/impls.ts): the store's release, the updater bridge's stop,
// the loopback's unpublish and the nuke-progress fan-out. Keeping them
// behind a setter keeps this handler module free of the root's wiring.
type RuntimeImpl = {
  releaseStore: Effect.Effect<void>;
  stopUpdaterBridge: () => void;
  // Unpublishes loopback.json, so the moved data dir never carries the
  // address of this pre-move process to a terminal that resolved the
  // new one.
  unpublishLoopback: Effect.Effect<void>;
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

class MoveRefusedError extends Schema.TaggedError<MoveRefusedError>()(
  "MoveRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const { set: setRuntimeImpl, get: runtimeImpl } = implSlot<RuntimeImpl>(
  "runtime handler invoked before setRuntimeImpl registered one",
);
export { setRuntimeImpl };

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
      // One move at a time, now that the local window is no longer the
      // only caller: two would share the staged pointer file and undo
      // each other's re-key.
      if (moveInFlight) {
        return yield* new MoveRefusedError({
          reason: "The data folder is already being moved.",
        });
      }
      if (unattended) {
        const refusal = runtimeImpl().unattendedMoveRefusal();
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
          const impl = runtimeImpl();
          return impl.releaseStore.pipe(
            Effect.andThen(Effect.sync(impl.stopUpdaterBridge)),
            Effect.andThen(impl.unpublishLoopback),
          );
        }),
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            // A move that failed after the watchers stopped leaves this
            // app running without them. At this machine the user sees
            // the error and can restart. For a peer's move nobody here
            // does, so the restart that brings them back happens anyway
            // (the data dir and pointer are where they were).
            if (unattended && watchersStopped) {
              runtimeImpl().relaunchAppUnattended();
            } else {
              moveInFlight = false;
            }
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
      if (unattended) runtimeImpl().relaunchAppUnattended();
    }),

  nuke: () =>
    Effect.gen(function* () {
      yield* nukeEverything(
        (progress) => runtimeImpl().broadcastNukeProgress(progress),
        killAllScripts(),
      ).pipe(
        // A wipe that failed past the rm still took the files along.
        Effect.ensuring(Effect.sync(() => runtimeImpl().afterDataWipe())),
      );
      // Nuke means "remove everything shigomori put on this machine";
      // the CLI links and the shell-integration hooks are part of that.
      // Settings offers a fresh install afterwards.
      yield* uninstallCliEverything;
    }),
} satisfies EffectHandlers<
  typeof runtimeContract,
  HandlerContext,
  HostServices
>;
