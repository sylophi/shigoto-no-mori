// Updates on the engine's updater (packages/engine/src/Updater.ts),
// which the terminal `sm update` shares, for the shell of either kind
// (`UpdaterSeat`): the Electron app's (main/electron/updater.ts) and a
// host's with no shell around it (headless/updater.ts). It embeds no
// updater of its own: checking stages in-process, which queries the
// feed, downloads, verifies, and parks the new release in
// <dataDir>/updates/staged. Installing hands the staged release to the
// shell's install, then quits: the app's spawns a detached
// `sm update --finish-install --pid <ours>`, which waits for this
// process to exit, swaps the bundle, and relaunches. A Linux host's
// puts it in place itself, and its unit starts the new one. The
// windows and the peers see a small state machine.
//
// The staged manifest on disk is the source of truth for "there is an
// update to restart into". A terminal `sm update` may have staged it
// without this process's state machine ever leaving idle, so boot
// seeds from the manifest and the install path re-checks it.
//
// Dev builds run from a checkout, so they report `unsupported` and the
// renderer hides the check button.
//
// `SHIGOMORI_UPDATE_RELEASES_URL` overrides the release list for
// end-to-end testing of a signed build, and `SHIGOMORI_UPDATE_FEED_URL`
// the update server it falls back to (the engine's Updater). The shell
// moves both out of its environment, for the check alone (endpoints.ts).
import path from "node:path";
import * as Option from "effect/Option";
import type {
  StagedManifest,
  UpdaterState,
} from "@shigomori/contracts/schemas";
import { InstallFailureSchema } from "@shigomori/contracts/schemas";
import { type Flavor, flavorNames } from "@shigomori/engine/flavor";
import { dataDir } from "@shared/paths";
import { readJson } from "@shared/jsonFile";
import { type BusyOperations, busyRemoteRefusal } from "@shared/busy";
import { log } from "@shared/log";
import { type InstallOutcome, makeBridge } from "./bridge";
import { updateEndpoints } from "./endpoints";
import { codeOf, messageOf } from "@shigomori/engine/errorDocument";
import * as Updater from "@shigomori/engine/Updater";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { errorMessageOf } from "@shigomori/contracts/errors";

// What the updater asks of the shell it runs in.
export type UpdaterSeat = {
  readonly flavor: Flavor;
  // A build from a checkout never updates.
  readonly packaged: boolean;
  readonly version: string;
  // The terminal `sm` this build ships, whose install the engine reads.
  readonly cliBinary: () => string;
  // The state as it moved, for the host, which answers the windows' and
  // the peers' reads and pushes it.
  readonly noteState: (state: UpdaterState) => void;
  // What the host is busy with (`quitAfter` as for a quit that follows).
  readonly busy: (quitAfter: boolean) => Promise<BusyOperations>;
  // Asks the person at this machine whether a busy restart goes ahead,
  // true to go on, and whether a quit they chose is under way. Null for
  // a shell nobody sits at, which refuses as for another device.
  readonly confirmRestart: {
    readonly ask: () => Promise<boolean>;
    readonly isQuitting: () => boolean;
  } | null;
  // Hands the staged update to its install, settled once that has
  // started (or failed to): the process quits a beat after (`quit`).
  readonly handOff: Effect.Effect<void, unknown, UpdaterServices>;
  readonly quit: () => void;
};

type UpdaterServices = Updater.Updater | FileSystem.FileSystem | Path.Path;

// An answer leaves before the process that gave it quits: a peer's
// direct link, or the loopback a window here called on, is torn down
// with it, so the quit trails the reply and the caller sees success
// instead of a dropped session. Shared with the app's relaunch.
export const QUIT_AFTER_ANSWER_MS = 500;

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
// The first check waits out the boot rush: staging can download
// hundreds of MB, and app-ready is exactly when the window is loading.
const FIRST_CHECK_DELAY_MS = 60 * 1000;
// Failed checks back off linearly (2, 3, ... ticks between attempts,
// capped at an hour): a repeatable failure re-runs the whole download
// pipeline, which shouldn't burn bandwidth every 10 minutes forever.
// Counted in ticks, not by the wall clock, which a step back would
// hold for as long as it went back.
const MAX_BACKOFF_TICKS = 6;
// Hard cap on one staging run (the download has its own deadline, its
// codesign and ditto children don't). A wedged child would otherwise
// pin checkInFlight forever and silently disable checks for the app's
// lifetime.
const STAGE_TIMEOUT_MS = 30 * 60 * 1000;

function readyStateFrom(manifest: {
  version: string;
  notes?: string;
  releaseDate?: string;
}): UpdaterState {
  return {
    kind: "ready",
    version: manifest.version,
    notes: manifest.notes,
    releaseDate: manifest.releaseDate ?? null,
  };
}

export const makeUpdater = (seat: UpdaterSeat) => {
  let state: UpdaterState = { kind: "idle" };
  let started = false;
  let installing = false;
  // Set before a move or a reset of the data folder (hold): no check or
  // install starts after it, until the restart that follows, or a move
  // that failed before the folder moved resumes it.
  let held = false;
  let checkInFlight = false;
  let failedChecks = 0;
  let ticksToCheck = 1;
  // Armed by updateNow (whether the install is unattended), null when
  // not: the next check to finish installs what it staged.
  let installWhenStaged: boolean | null = null;
  // Set when that arm landed while a check was already running, which
  // may have asked before the release was out.
  let armedMidCheck = false;

  // The bridge `sm update` reaches this updater through.
  const bridge = makeBridge(seat.version);

  // The install's handoff quits, and what installs after it (the app's
  // installer, a host's unit) waits for this process to exit. This flag
  // makes that a hurried quit, which signals scripts instead of waiting
  // them out, so a slow cleanup cannot hold the update back.
  function isInstallingUpdate(): boolean {
    return installing;
  }

  function setState(next: UpdaterState): void {
    state = next;
    publish();
  }

  // The state as the windows, the peers and `sm update` see it: marked
  // `updating` while an install is under way or armed (updateNow), so
  // every button that would start one waits on it instead.
  function shownState(): UpdaterState {
    const updating = installing || installWhenStaged !== null;
    return updating &&
      (state.kind === "checking" ||
        state.kind === "downloading" ||
        state.kind === "ready")
      ? { ...state, updating }
      : state;
  }

  function publish(): void {
    const shown = shownState();
    seat.noteState(shown);
    // Mirror every state to disk so `sm update` can follow along
    // (bridge.ts). Fire-and-forget: transitions are seconds apart, and a
    // lost write only stales the CLI's view until the next one.
    fork?.(bridge.publishState(shown));
  }

  // What a failed finish-install left for this start, taken so the next
  // start doesn't show it again.
  const takeInstallFailure = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = Updater.updaterFiles(path, dataDir()).installFailure;
    const failure = yield* readJson(file, InstallFailureSchema).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (failure !== null) yield* fs.remove(file).pipe(Effect.ignore);
    return failure;
  });

  // The staged update this build can restart into.
  const installableStaged = Effect.flatMap(Updater.Updater, (updater) =>
    updater.staged(seat.version),
  ).pipe(Effect.map(Option.getOrNull));

  // The same, from the Promise code below: nothing while the updater's
  // layer is down.
  function readInstallableStaged(): Promise<StagedManifest | null> {
    return run === null ? Promise.resolve(null) : run(installableStaged);
  }

  // The app as the updater sees it: the bundled `sm` sits in the install
  // it updates.
  function runningApp(): Updater.Running {
    return {
      version: seat.version,
      arch: process.arch,
      executable: seat.cliBinary(),
      pid: process.pid,
    };
  }

  // A check, started from outside the updater's layer (the host's call,
  // updateNow, a staged arm): on the layer's own runtime, nothing while
  // it is down.
  let fork:
    | ((effect: Effect.Effect<void, never, UpdaterServices>) => void)
    | null = null;
  let run:
    | (<A>(effect: Effect.Effect<A, never, UpdaterServices>) => Promise<A>)
    | null = null;
  function checkForUpdates(): void {
    fork?.(checkInTurn);
  }
  // Ends the check under way, on the layer's handle (hold).
  let endCheck: Effect.Effect<void> | null = null;
  let checkInTurn: Effect.Effect<void, never, UpdaterServices> = Effect.void;

  // One check at a time. The engine holds a cross-process staging lock,
  // so a terminal `sm update` racing this check is also safe. The
  // loser reports "update-in-progress" and is treated as a skip, not an
  // error.
  //
  // Checks keep running after an update is staged, or a release that
  // ships later would wait for a restart into the older one first.
  // These re-checks run behind the "ready" state they found and leave
  // its restart button up throughout: the engine keeps the staged bundle
  // until a newer one is verified, so a restart mid-download still has
  // it to install (and quitting reaps the download). Only a newly staged
  // release or a confirmed up-to-date answer (the release was pulled,
  // and the stage cleared it) replaces it. A failure keeps it while its
  // bundle is still on disk, and still backs off.
  const stage = (shown: UpdaterState | null) =>
    Effect.flatMap(Updater.Updater, (updater) =>
      updater.stage({
        running: runningApp(),
        ...updateEndpoints(),
        // "verifying" arrives too, and the renderer's machine collapses
        // everything between "found one" and "staged" into downloading,
        // which names the release from the first event.
        progress: (progress) =>
          Effect.sync(() => {
            if (
              shown === null &&
              (progress.phase === "downloading" ||
                progress.phase === "verifying") &&
              state.kind !== "downloading"
            ) {
              setState({ kind: "downloading", version: progress.version });
            }
          }),
      }),
    ).pipe(Effect.timeout(STAGE_TIMEOUT_MS));

  // A call turned away here leaves the flag to the check under way: only
  // a check that ran clears it.
  const runCheck: Effect.Effect<void, never, UpdaterServices> = Effect.suspend(
    () =>
      !started || held || checkInFlight || state.kind === "downloading"
        ? Effect.void
        : check,
  );

  const check: Effect.Effect<void, never, UpdaterServices> = Effect.gen(
    function* () {
      checkInFlight = true;
      const shown = state.kind === "ready" ? state : null;
      if (shown === null) setState({ kind: "checking" });
      const staged = yield* Effect.result(stage(shown));
      let next: UpdaterState;
      if (Result.isSuccess(staged)) {
        next =
          staged.success.status === "staged"
            ? readyStateFrom(staged.success)
            : { kind: "idle" };
      } else if (codeOf(staged.failure) === "update-in-progress") {
        // A terminal `sm update` holding the staging lock is its turn,
        // not an error.
        next = shown ?? { kind: "idle" };
      } else {
        next = { kind: "error", message: messageOf(staged.failure) };
      }
      const failed = next.kind === "error";
      if (next.kind === "error") log.warn(`[updater] ${next.message}`);
      // What is staged stays up over a failed check: the release shown,
      // or one a failed install's error stood in front of at boot.
      if (failed) {
        const onDisk = yield* installableStaged;
        if (onDisk !== null) next = readyStateFrom(onDisk);
      }
      setState(next);
      failedChecks = failed ? failedChecks + 1 : 0;
      ticksToCheck = failed ? Math.min(failedChecks + 1, MAX_BACKOFF_TICKS) : 1;
      // updateNow's arm (see there). One that landed mid-check gets one
      // check of its own before a miss drops it.
      const unattended = installWhenStaged;
      if (unattended !== null && state.kind !== "ready" && armedMidCheck) {
        armedMidCheck = false;
        checkInFlight = false;
        yield* Effect.suspend(() => runCheck);
        return;
      }
      installWhenStaged = null;
      armedMidCheck = false;
      if (unattended !== null && state.kind === "ready") {
        // Nobody waits on this call to hear a busy host's refusal, and the
        // update stays staged behind the usual restart button. The state
        // says `updating` until the install starts or is refused.
        installUpdate(unattended)
          .catch(() => undefined)
          .finally(publish);
      }
    },
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        checkInFlight = false;
      }),
    ),
  );

  // True when the staged update is installable (the engine's
  // Updater.staged). When it's gone while the UI still says ready, resets
  // to idle rather than leave a dead "Restart to update" button up until
  // the next check.
  async function hasInstallableStaged(): Promise<boolean> {
    if ((await readInstallableStaged()) !== null) return true;
    if (state.kind === "ready") setState({ kind: "idle" });
    return false;
  }

  // The install handoff, shared by Settings (this window's or a peer's),
  // and the CLI's bridge request: verify something really is staged
  // (the disk manifest, not this process's possibly-stale state
  // machine), confirm with the user if scripts are running, then spawn
  // the detached installer and quit. An UNATTENDED install (asked for
  // from another device) cannot confirm anything, so a busy host throws
  // the refusal instead and the caller's toast carries it.
  async function installUpdate(unattended: boolean): Promise<InstallOutcome> {
    if (installing) return "installing";
    if (held) throw new Error(heldWords);
    if (!(await hasInstallableStaged())) return "nothing-staged";
    const confirm = seat.confirmRestart;
    if (unattended || confirm === null) {
      const refusal = busyRemoteRefusal(await seat.busy(true), "restart");
      if (refusal !== null) throw new Error(refusal);
    } else {
      if (!(await confirm.ask())) return "declined";
      // The dialog can sit open arbitrarily long. Re-check that another
      // path didn't start the install during it, and that the staged
      // update still exists: a terminal run whose feed answered 204
      // clears it, and quitting with nothing staged would be a quit the
      // installer can't follow with a relaunch.
      if (installing) return "installing";
      if (!(await hasInstallableStaged())) return "nothing-staged";
      // A quit the person chose meanwhile ends the app without the update
      // (its scripts stopping is what let this prompt go ahead).
      if (confirm.isQuitting()) return "declined";
    }
    // A move or a reset of the data folder that began while the dialog
    // was up.
    if (held) throw new Error(heldWords);
    installing = true;
    publish();
    try {
      // Settles only once the install has started: quitting on one that
      // failed to start would end the app with nothing to bring it back.
      const handedOff =
        run === null
          ? Result.fail(new Error("The updater isn't running."))
          : await run(Effect.result(seat.handOff));
      if (Result.isFailure(handedOff)) throw handedOff.failure;
    } catch (err) {
      installing = false;
      setState({
        kind: "error",
        message: errorMessageOf(err),
      });
      // The caller reads success as "restarting" (Update all restarts the
      // asking machine on a peer's), so the failure rides back to its
      // toast.
      throw err;
    }
    // The caller's invoke is answered when this handler resolves, and
    // quit tears its listener down before a queued frame can leave (a
    // peer's direct one, or the loopback this machine's window called
    // on), so the install returns first and quits a beat later. The
    // caller then sees success instead of a dropped-session error for an
    // update that is installing fine. `installing` blocks a second run
    // in the gap.
    setTimeout(seat.quit, QUIT_AFTER_ANSWER_MS);
    return "installing";
  }

  // Update this device, whether or not its update is here yet: Update
  // all and the update toast ask every device behind the newest release
  // they know of, and a device whose last check predates that release
  // has nothing staged. Such a device is armed, and the check that stages
  // the update installs it (runCheck). A check already running is
  // followed by one more, since it may have asked before the release was
  // out. An unattended request is refused up front on a busy host, while
  // the caller still waits on the answer.
  async function updateNow(unattended: boolean): Promise<void> {
    if (installing) return;
    if (held) throw new Error(heldWords);
    if ((await readInstallableStaged()) !== null) {
      await installUpdate(unattended);
      return;
    }
    if (!started) throw new Error("This build doesn't update itself.");
    if (unattended) {
      const refusal = busyRemoteRefusal(await seat.busy(false), "restart");
      if (refusal !== null) throw new Error(refusal);
    }
    installWhenStaged = unattended;
    if (checkInFlight) {
      armedMidCheck = true;
      publish();
    } else {
      // Says `updating` before this answers, ahead of the check's own.
      setState({ kind: "checking" });
      checkForUpdates();
    }
  }

  // What an install asked for during a hold answers.
  let heldWords = "";

  // Before a move or a reset of the data folder, which staging writes
  // under and an install restarts out of: the version an install under
  // way restarts into ("" when not known), which the caller refuses on.
  // Otherwise no check or install starts from here on, and a check under
  // way is ended (its staging lock goes with it, and the next run prunes
  // what it left). The bridge keeps answering `sm update` (with these
  // words): a move stops it once nothing can fail before the folder moves
  // (stopUpdaterBridge), and a reset's folder goes at the next start.
  async function hold(input: {
    readonly for: "move" | "reset";
  }): Promise<string | null> {
    if (installing) return state.kind === "ready" ? state.version : "";
    held = true;
    // An Update now armed for the check this ends goes with it, rather
    // than come back with a later check after a resume.
    installWhenStaged = null;
    armedMidCheck = false;
    heldWords =
      input.for === "move"
        ? "The data folder is being moved. The update can install once the app has restarted."
        : "The app is being reset. The update can install once it has restarted.";
    if (endCheck !== null) await Effect.runPromise(endCheck);
    if (state.kind === "checking" || state.kind === "downloading") {
      state = { kind: "idle" };
    }
    publish();
    return null;
  }

  // A move that failed before the folder moved: the app carries on, and
  // its updater with it.
  function resume(): void {
    held = false;
  }

  // The state as it stands, for a host that starts after it moved.
  function currentUpdaterState(): UpdaterState {
    return shownState();
  }

  // The updater's half of the host's calls to its shell: a peer's
  // Settings page drives it through the host.
  const updaterCalls = {
    check: async () => checkForUpdates(),
    install: async (unattended: boolean) =>
      void (await installUpdate(unattended)),
    update: updateNow,
    hold,
    resume: async () => resume(),
  };

  // The updater, for the length of the shell's graph: the staged update
  // seeded from disk, then a check a minute in and every interval after
  // (backed off after failures). A dev build reports "unsupported", and
  // publishes it too, so `sm update` reads that instead of waiting on a
  // bridge that will never start.
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const runFork = yield* FiberSet.makeRuntime<UpdaterServices>();
      const runPromise = yield* FiberSet.makeRuntimePromise<UpdaterServices>();
      fork = (effect) => void runFork(effect);
      run = runPromise;
      // Every check on one handle: one at a time, and a hold ends the one
      // under way.
      const checks = yield* FiberHandle.make<void>();
      // Awaited, not joined: a check asked while one runs is skipped, the
      // handle answering it with a fiber already interrupted, which a join
      // would pass on to the asker (the periodic loop, ended for good).
      checkInTurn = FiberHandle.run(checks, runCheck, {
        onlyIfMissing: true,
      }).pipe(Effect.flatMap(Fiber.await), Effect.asVoid);
      endCheck = FiberHandle.clear(checks);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fork = null;
          run = null;
          endCheck = null;
          checkInTurn = Effect.void;
        }),
      );
      // A dev run, or a test flavor, has no releases to move to, but a
      // test flavor the lab hands a stand-in list.
      const { feedUrl, releasesUrl } = updateEndpoints();
      const names = flavorNames(seat.flavor);
      const standIn = names.debuggable && Boolean(feedUrl || releasesUrl);
      if (!seat.packaged || (!names.updates && !standIn)) {
        setState({ kind: "unsupported" });
        return;
      }
      started = true;
      // On boot, so `sm update` doesn't take this run for the last one.
      publish();
      // The CLI runs at this machine's own terminal, so its install is
      // attended.
      yield* bridge.serve({
        install: () => installUpdate(false),
        failed: (error) => {
          const message = `Couldn't read the update request: ${Updater.causeText(error)}`;
          // Once, not on every poll it keeps failing.
          if (state.kind === "error" && state.message === message) return;
          log.warn(`[updater] ${message}`);
          setState({ kind: "error", message });
        },
      });
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          // Seed from disk before any network work: an update staged
          // earlier (by a previous run, or by `sm update` in a terminal)
          // is ready immediately, before any check. The first check still
          // runs, in case a newer release has shipped since.
          const staged = yield* installableStaged;
          if (staged !== null) setState(readyStateFrom(staged));
          // The last install's failure, which its installer left as it
          // relaunched this build (or as nothing relaunched). Shown over a
          // staged update until the first check, once.
          const failure = yield* takeInstallFailure;
          if (failure !== null) {
            log.warn(`[updater] the last install failed: ${failure.message}`);
            setState({
              kind: "error",
              message: failure.message,
              install: true,
            });
          }
          yield* Effect.sleep(FIRST_CHECK_DELAY_MS);
          yield* checkInTurn;
          return yield* Effect.forever(
            Effect.sleep(CHECK_INTERVAL_MS).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  ticksToCheck -= 1;
                  return ticksToCheck <= 0 ? checkInTurn : Effect.void;
                }),
              ),
            ),
          );
        }),
      );
    }),
  );

  return {
    layer,
    calls: updaterCalls,
    isInstallingUpdate,
    currentUpdaterState,
    releaseBridge: bridge.release,
  };
};
