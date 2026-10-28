// The Shell service (host/lib/Shell.ts) of a host with no shell around
// it: nobody is at it to show anything to, so what a shell would show
// is logged. A restart is a quit, which the service manager that keeps
// the host running (the systemd unit) starts again, which keeps it
// reachable too. The updater runs here (updater.ts), the account's
// command switch is account.ts's, and there is no window for a guide
// to drive.
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Shell from "@host/lib/Shell";
import { quit } from "@host/process/run";
import type { HostFacts } from "@shared/hostFacts";
import type { HeadlessAccount } from "./account";
import { makeHeadlessUpdater } from "./updater";

const refused = (words: string) => Effect.fail(callFailureOf(new Error(words)));

// A Promise call of the updater's, its refusal in its own words.
const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

export const layer = (
  facts: HostFacts,
  account: Pick<HeadlessAccount, "setAcceptsCommands">,
) => {
  const updater = makeHeadlessUpdater(facts);
  const relaunch = Effect.sync(() => quit(true));
  return Layer.succeed(
    Shell.Shell,
    Shell.Shell.of({
      relaunch,
      // The folder was let go of, so only a restart goes on from here.
      moveFailed: (reason) =>
        Effect.logError(`The data folder move failed: ${reason}`).pipe(
          Effect.andThen(relaunch),
        ),
      updater: {
        check: call(updater.calls.check),
        install: (unattended) => call(() => updater.calls.install(unattended)),
        update: (unattended) => call(() => updater.calls.update(unattended)),
        state: Effect.sync(updater.currentUpdaterState),
        // The updater is in this process, and says its moves itself.
        noteState: () => Effect.void,
      },
      holdUpdater: (forWhat) =>
        Effect.promise(() => updater.calls.hold({ for: forWhat })),
      resumeUpdater: Effect.promise(updater.calls.resume),
      stopUpdaterBridge: Effect.promise(updater.releaseBridge),
      migration: () => Effect.void,
      guide: () => refused("This machine has no window to guide."),
      setAcceptsCommands: (enabled) =>
        call(() => account.setAcceptsCommands(enabled)),
      keepReachable: Effect.succeed(null),
      setKeepReachable: () =>
        refused(
          "On Linux the service keeps the host running (`sm service status`).",
        ),
    }),
  ).pipe(Layer.merge(updater.layer));
};
