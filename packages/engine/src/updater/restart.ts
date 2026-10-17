// The updater's view of the running app: whether it is up, and asking it to quit or restart.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { InstallFailure } from "@shigomori/contracts/schemas/runtime";
import { elapsedMillis } from "../elapsed.ts";
import { type AppStatus, formatLocalRfc3339 } from "../updateFeed.ts";
import {
  HandoffFailed,
  RESTART_HINT_AFTER,
  RESTART_TIMEOUT,
  type UpdateInput,
  polling,
  report,
} from "./documents.ts";
import type { FilesArea } from "./files.ts";

export const makeRestart = ({ files }: { readonly files: FilesArea }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const {
      updates: updatesDir,
      installLog,
      installFailure,
      status: statusPath,
    } = files.at;
    const { appAlive, readStatus, writeShared } = files;
    // The handed-off install restarts the app. Success is updater.json
    // naming a new pid and a new version: a failed swap relaunching the old
    // bundle mustn't read as "updated X -> X". An error the old pid
    // publishes after the request (its installer didn't start) fails at
    // once. A busy app confirms in a dialog this can't see, and a decline
    // runs out the clock with the old pid alive.
    const waitForRestart = Effect.fn("Updater.waitForRestart")(function* (
      app: AppStatus,
      requestedAt: number,
      input: UpdateInput,
    ) {
      const start = yield* elapsedMillis;
      let sameVersion = false;
      let hinted = false;
      const look = Effect.gen(function* () {
        const status = Option.getOrUndefined(yield* readStatus);
        if (
          status !== undefined &&
          status.pid !== app.pid &&
          (yield* appAlive(status.pid))
        ) {
          if (status.appVersion !== app.appVersion) return Option.some(status);
          sameVersion = true;
        }
        const state = status?.state;
        if (status?.pid === app.pid && state?.kind === "error") {
          // Only an error written since the request: the app never clears
          // one from an earlier failed check on this path.
          const info = yield* fs.stat(statusPath).pipe(Effect.option);
          const written = Option.flatMap(info, (stat) => stat.mtime);
          if (Option.isSome(written) && written.value.getTime() > requestedAt) {
            return yield* new HandoffFailed({
              reason: "install",
              detail: state.message,
            });
          }
        }
        if (!hinted && (yield* elapsedMillis) - start > RESTART_HINT_AFTER) {
          hinted = true;
          yield* report(input, { phase: "waiting-for-restart" });
        }
        return Option.none<AppStatus>();
      });
      const restarted = yield* look.pipe(
        Effect.repeat({
          until: Option.isSome,
          schedule: polling(RESTART_TIMEOUT),
        }),
      );
      if (Option.isSome(restarted)) return restarted.value;
      // Tentative, since a late confirmation still installs after this has
      // given up: the staged update survives until it is used.
      return yield* sameVersion
        ? new HandoffFailed({
            reason: "same-version",
            version: app.appVersion,
            log: installLog,
          })
        : new HandoffFailed({ reason: "timeout" });
    });

    const appendInstallLog = (line: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(updatesDir, { recursive: true });
        const now = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          installLog,
          `${formatLocalRfc3339(now)} ${line}\n`,
          { flag: "a" },
        );
      }).pipe(Effect.ignore);

    // A finish-install that failed, for the log and for the next app
    // start, which shows it: before the relaunch of the current app that
    // may follow, so that start finds it.
    const noteInstallFailure = (
      pid: number,
      line: string,
      failure: InstallFailure,
    ) =>
      appendInstallLog(`finish-install: ${line}`).pipe(
        Effect.andThen(
          writeShared(
            installFailure,
            `${JSON.stringify(failure, null, 2)}\n`,
            pid,
          ),
        ),
        Effect.ignore,
      );

    return { waitForRestart, appendInstallLog, noteInstallFailure };
  });

export type RestartArea = Effect.Success<ReturnType<typeof makeRestart>>;
