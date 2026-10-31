// The updater's view of the running app: whether it is up, and asking it to quit or restart.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { InstallFailure } from "@shigomori/contracts/schemas/runtime";
import { elapsedMillis } from "../elapsed.ts";
import { type AppStatus, formatLocalRfc3339 } from "../updateFeed.ts";
import {
  CLAIM_WITHIN,
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
      request: requestPath,
    } = files.at;
    const { appAlive, readStatus, writeShared } = files;
    // The handed-off install restarts the app. Success is updater.json
    // naming a new pid and a new version: a failed swap relaunching the old
    // bundle mustn't read as "updated X -> X". The app says what became of
    // this request (`handoff`, by its id): a decline, nothing it could
    // install or an installer that didn't start fails at once. One no app
    // takes is withdrawn, and so is one this run leaves on its way out, so
    // no app picks it up after the asker gave up. A withdraw that finds
    // it gone was taken meanwhile, and the wait goes on.
    const waitForRestart = Effect.fn("Updater.waitForRestart")(function* (
      app: AppStatus,
      id: string,
      input: UpdateInput,
    ) {
      const start = yield* elapsedMillis;
      let sameVersion = false;
      let hinted = false;
      let claimed = false;
      // Whether this took the request back, false when the app had taken
      // it. One that can't be renamed fails, since it may still be taken.
      const withdraw = fs.rename(requestPath, `${requestPath}.withdrawn`).pipe(
        Effect.andThen(
          Effect.ignore(fs.remove(`${requestPath}.withdrawn`, { force: true })),
        ),
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(false),
        ),
        Effect.mapError(
          (cause) => new HandoffFailed({ reason: "withdraw", cause }),
        ),
      );
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
        const handoff = status?.handoff;
        if (handoff?.id === id) {
          claimed = true;
          switch (handoff.outcome) {
            case "declined":
            case "nothing-staged":
              return yield* new HandoffFailed({ reason: handoff.outcome });
            case "failed":
              return yield* new HandoffFailed({
                reason: "install",
                detail: handoff.message,
              });
          }
        }
        const waited = (yield* elapsedMillis) - start;
        if (!claimed && waited > CLAIM_WITHIN) {
          if (yield* withdraw) {
            return yield* new HandoffFailed({ reason: "not-taken" });
          }
          claimed = true;
        }
        if (!hinted && waited > RESTART_HINT_AFTER) {
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
        Effect.onInterrupt(() =>
          claimed ? Effect.void : Effect.ignore(withdraw),
        ),
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
