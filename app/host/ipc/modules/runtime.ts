import { homedir } from "node:os";
import { resolve } from "node:path";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { uninstallCliEverything } from "@host/lib/cli/install";
import { errorWordsOf } from "@host/lib/errorWords";
import * as Ops from "@host/lib/engineOps";
import { leftIf, nukeEverything } from "@host/lib/nuke";
import * as Terminals from "@host/lib/terminals/Terminals";
import { moveDataDir, sessionPlace } from "@host/lib/dataDirMove";
import * as Scripts from "@host/lib/Scripts";
import { busyRemoteRefusal } from "@shared/busy";
import { DataDirHolders } from "@host/lib/DataDirHolders";
import * as HostPushes from "@host/lib/HostPushes";
import * as Shell from "@host/lib/Shell";
import * as Moves from "@host/lib/sync/Moves";
import * as AccountPeers from "@host/lib/control/AccountPeers";
import { nameOf } from "@host/lib/control/plan";
import type { HostServices } from "@host/process/services";
import {
  canonicalDataDirName,
  dataDir,
  dataDirSource,
  defaultDataDir,
} from "@shared/paths";

class MoveRefusedError extends Schema.TaggedError<MoveRefusedError>()(
  "MoveRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

let moveInFlight = false;

// What the moves have under way, the peers bringing from here by their
// names on the account, read for a moment only: a refusal's words are
// not worth holding the move's lock on an unreachable hub.
const underWayByName = (
  moves: Moves.Moves["Service"],
  account: AccountPeers.AccountPeers["Service"],
) =>
  Effect.gen(function* () {
    const { moving, bringing } = yield* moves.underWay;
    if (bringing.length === 0) return { moving, bringing };
    const devices = yield* account.listDevices.pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.succeed([]),
      }),
      Effect.orElseSucceed(() => []),
    );
    const named = new Set(
      bringing.map((deviceId) => {
        const device = devices.find((each) => each.deviceId === deviceId);
        return device === undefined ? "another device" : nameOf(device);
      }),
    );
    const names = [...named].toSorted((x, y) =>
      x === "another device" ? 1 : y === "another device" ? -1 : 0,
    );
    const [first = "", ...rest] = names;
    return {
      moving,
      bringing: [first.charAt(0).toUpperCase() + first.slice(1), ...rest],
    };
  });

// What follows a data-folder move that failed. Before the host let go
// of the folder, nothing: the app carries on where it was. After, it
// runs without its loopback and store watch, so it restarts: for a
// peer's move at once, nobody here to ask; for one asked here, once
// the user has read why (the shell's dialog, whose one button
// restarts and whose dismissal quits).

export const afterFailedMove = ({
  watchersStopped,
  unattended,
}: {
  watchersStopped: boolean;
  unattended: boolean;
}): "carry-on" | "relaunch" | "ask" =>
  !watchersStopped ? "carry-on" : unattended ? "relaunch" : "ask";

export const runtimeHandlers = {
  // Host facts only. isDev deliberately isn't here: it describes the
  // client build and rides the preload bridge (api.isDev) instead.
  info: () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = dataDir();
      const real = yield* fs
        .realPath(dir)
        .pipe(Effect.orElseSucceed(() => dir));
      return {
        dataDir: dir,
        ...(real === dir ? {} : { dataDirReal: real }),
        dataDirSource: dataDirSource(),
        // resolve() drops the trailing slash a hand-edited pointer may carry.
        atDefaultDataDir: resolve(dir) === defaultDataDir(),
        canonicalDataDirName: canonicalDataDirName(),
        homedir: homedir(),
      };
    }),

  moveDataDir: ({ parentDir }, ctx) =>
    Effect.gen(function* () {
      const unattended = isRemoteCaller(ctx);
      const shell = yield* Shell.Shell;
      const holders = yield* DataDirHolders;
      const scripts = yield* Scripts.Scripts;
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
        const refusal = busyRemoteRefusal(yield* scripts.busy, "move");
        if (refusal !== null) {
          return yield* new MoveRefusedError({ reason: refusal });
        }
      }
      moveInFlight = true;
      let watchersStopped = false;
      yield* moveDataDir(parentDir, {
        place: yield* sessionPlace,
        killAllScripts: scripts.stopAll(),
        movesUnderWay: underWayByName(
          yield* Moves.Moves,
          yield* AccountPeers.AccountPeers,
        ),
        beforeMove: Effect.suspend(() => {
          watchersStopped = true;
          return holders.release;
        }),
      }).pipe(
        Effect.onError((cause) =>
          Effect.suspend(() => {
            // A move that failed after the watchers stopped leaves this
            // app running without them. At this machine the shell says
            // why and offers a restart, or quits. For a peer's move
            // nobody here does, so the restart that brings them back
            // happens anyway (the data dir and pointer are where they
            // were).
            switch (afterFailedMove({ watchersStopped, unattended })) {
              case "relaunch":
                return shell.relaunch;
              case "ask":
                return shell.moveFailed(errorWordsOf(Cause.squash(cause)));
              case "carry-on":
                moveInFlight = false;
                return Effect.void;
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
      if (unattended) yield* shell.relaunch;
    }),

  nuke: () =>
    Effect.gen(function* () {
      const terminals = yield* Terminals.Terminals;
      return yield* nukeEverything({
        onProgress: (progress) =>
          HostPushes.push(runtimeContract, "nukeProgress", progress),
        killAllScripts: (yield* Scripts.Scripts).stopAll(),
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
      });
    }),
} satisfies EffectHandlers<
  typeof runtimeContract,
  HandlerContext,
  HostServices
>;
