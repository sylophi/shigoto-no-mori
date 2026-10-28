// The Shell service (host/lib/Shell.ts) of a host with no shell around
// it: nobody is at it to show anything to, so what a shell would show
// is logged. A restart is a quit, which the service manager that keeps
// the host running (the systemd unit) starts again. There is no
// updater here, and no window for a guide to drive.
import { callFailureOf } from "@shigomori/contracts/errors";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Shell from "@host/lib/Shell";
import { quit } from "@host/process/run";

const refused = (words: string) => Effect.fail(callFailureOf(new Error(words)));
const noUpdater = refused("This machine's host has no updater.");

export const layer = Layer.effect(
  Shell.Shell,
  Effect.gen(function* () {
    const state = yield* Ref.make<UpdaterState>({ kind: "unsupported" });
    const relaunch = Effect.sync(() => quit(true));
    return Shell.Shell.of({
      relaunch,
      // The folder was let go of, so only a restart goes on from here.
      moveFailed: (reason) =>
        Effect.logError(`The data folder move failed: ${reason}`).pipe(
          Effect.andThen(relaunch),
        ),
      updater: {
        check: noUpdater,
        install: () => noUpdater,
        update: () => noUpdater,
        state: Ref.get(state),
        noteState: (next) => Ref.set(state, next),
      },
      holdUpdater: () => Effect.succeed(null),
      resumeUpdater: Effect.void,
      stopUpdaterBridge: Effect.void,
      migration: () => Effect.void,
      guide: () => refused("This machine has no window to guide."),
    });
  }),
);
