// In-app updates, with the CLI as the engine. The app no longer embeds
// an updater at all (Squirrel is gone): checking shells out to
// `sm update --stage --json` (cli/updater.go), which queries the feed,
// downloads, signature-verifies, and parks the new bundle in
// <dataDir>/updates/staged. Installing spawns a detached
// `sm update --finish-install --pid <ours>` and quits. The installer
// waits for this process to exit, swaps the bundle, and relaunches.
// The renderer sees the same small state machine as before.
//
// The staged manifest on disk is the source of truth for "there is an
// update to restart into". A terminal `sm update` may have staged it
// without this process's state machine ever leaving idle, so boot
// seeds from the manifest and the install path re-checks it.
//
// Dev builds run from a checkout, so they report `unsupported` and the
// renderer hides the check button.
//
// `SHIGOMORI_UPDATE_FEED_URL` still overrides the feed for end-to-end
// testing of a signed build, and `SHIGOMORI_UPDATE_RELEASES_URL` the
// release list a prerelease build ranks instead (cli/updater.go). The
// CLI child inherits both from our environment.
import { join } from "node:path";
import { app } from "electron";
import { updaterContract } from "@shared/ipc/modules/updater";
import type { StagedManifest, UpdaterState } from "@shared/schemas";
import {
  StagedManifestSchema,
  UpdateStageEventSchema,
  UpdateStageResultSchema,
} from "@shared/schemas";
import { setUpdaterImpl } from "@host/ipc/modules/updater";
import { broadcastAll } from "../ipc/register";
import { readJsonOrNull } from "@host/lib/util/jsonFile";
import { pathExists, dataDir } from "@host/lib/util/paths";
import { busyActionRemoteRefusal, confirmBusyAction } from "./busyPrompt";
import { cliFailureMessage, runCli, spawnCliDetached } from "./cliRunner";
import { UNATTENDED_QUIT_DELAY_MS } from "./relaunch";
import { publishUpdaterState, startUpdaterBridge } from "./updaterBridge";
import { errorMessageOf } from "@shared/errors";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
// The first check waits out the boot rush: staging can download
// hundreds of MB, and app-ready is exactly when the window is loading.
const FIRST_CHECK_DELAY_MS = 60 * 1000;
// Failed checks back off linearly (2, 3, ... ticks between attempts,
// capped at an hour): a repeatable failure re-runs the whole download
// pipeline, which shouldn't burn bandwidth every 10 minutes forever.
const MAX_BACKOFF_TICKS = 6;
// Hard cap on one staging run (the Go side allows up to 20 min for the
// download but puts no deadline on its codesign/ditto subprocesses). A
// wedged child would otherwise pin checkInFlight forever and silently
// disable checks for the app's lifetime.
const STAGE_TIMEOUT_MS = 30 * 60 * 1000;

let state: UpdaterState = { kind: "idle" };
let started = false;
let installing = false;
let checkInFlight = false;
let failedChecks = 0;
let nextAutoCheckAt = 0;

// The finish-install handoff calls app.quit(), which still emits
// before-quit. The app-wide before-quit handler in index.ts intercepts
// that to reap orphan scripts. If its cleanup ever stalls, the update
// never lands. This flag lets that handler bail out and let the
// natural quit through.
export function isInstallingUpdate(): boolean {
  return installing;
}

function setState(next: UpdaterState): void {
  state = next;
  broadcastAll(updaterContract, "state", state);
  // Mirror every state to disk so `sm update` can follow along
  // (updaterBridge.ts). Fire-and-forget: transitions are seconds apart,
  // and a lost write only stales the CLI's view until the next one.
  void publishUpdaterState(state);
}

export function getUpdaterState(): UpdaterState {
  return state;
}

// Mirrors cli/updater.go stagedDir()/stagedManifestPath().
const stagedDir = () => join(dataDir(), "updates", "staged");

// null unless a well-formed manifest describes a bundle that is
// actually on disk.
async function readStagedManifest(): Promise<StagedManifest | null> {
  const manifest = await readJsonOrNull(
    join(stagedDir(), "manifest.json"),
    StagedManifestSchema,
  ).catch(() => null);
  if (manifest === null) return null;
  if (!(await pathExists(join(stagedDir(), manifest.bundleName)))) return null;
  return manifest;
}

// The staged update, if it's one this build can restart into. A
// manifest matching our own version is debris from an install that
// crashed between swap and cleanup. Offering it would restart-loop
// into the same version. The CLI clears it on its next stage run.
async function readInstallableStaged(): Promise<StagedManifest | null> {
  const staged = await readStagedManifest();
  return staged !== null && staged.version !== app.getVersion() ? staged : null;
}

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

export function checkForUpdates(): void {
  void runCheck();
}

// One check at a time. The CLI holds its own cross-process staging
// lock, so a terminal `sm update` racing this check is also safe. The
// loser reports "update-in-progress" and is treated as a skip, not an
// error.
//
// Checks keep running after an update is staged, or a release that
// ships later would wait for a restart into the older one first.
// These re-checks run behind the "ready" state they found and leave
// its restart button up throughout: the CLI keeps the staged bundle
// until a newer one is verified, so a restart mid-download still has
// it to install (and quitting reaps the download). Only a newly staged
// release or a confirmed up-to-date answer (the release was pulled,
// and the CLI cleared it) replaces it. A failure keeps it while its
// bundle is still on disk, and still backs off.
async function runCheck(): Promise<void> {
  if (!started || checkInFlight) return;
  if (state.kind === "downloading") return;
  checkInFlight = true;
  const shown = state.kind === "ready" ? state : null;
  if (shown === null) setState({ kind: "checking" });
  let failed = false;
  try {
    let next: UpdaterState;
    try {
      const result = await runCli(
        ["update", "--stage"],
        (doc) => {
          // "verifying" arrives too, and the renderer's machine
          // collapses everything between "found one" and "staged" into
          // downloading.
          if (
            shown === null &&
            UpdateStageEventSchema.safeParse(doc).success &&
            state.kind !== "downloading"
          ) {
            setState({ kind: "downloading" });
          }
        },
        undefined,
        { background: true, timeoutMs: STAGE_TIMEOUT_MS },
      );
      const final = result.docs.findLast(
        (doc) => typeof doc["ok"] === "boolean",
      );
      const parsed =
        final?.["ok"] === true
          ? UpdateStageResultSchema.safeParse(final)
          : null;
      if (parsed?.success === true && parsed.data.status === "staged") {
        next = readyStateFrom(parsed.data);
      } else if (
        parsed?.success === true &&
        parsed.data.status === "up-to-date"
      ) {
        next = { kind: "idle" };
      } else if (final?.["code"] === "update-in-progress") {
        // A terminal `sm update` holding the staging lock is its turn,
        // not an error.
        next = shown ?? { kind: "idle" };
      } else {
        next = {
          kind: "error",
          message: cliFailureMessage(result, "Update check failed"),
        };
      }
    } catch (err) {
      next = { kind: "error", message: errorMessageOf(err) };
    }
    failed = next.kind === "error";
    if (
      failed &&
      shown !== null &&
      (await readInstallableStaged())?.version === shown.version
    ) {
      next = shown;
    }
    setState(next);
  } finally {
    checkInFlight = false;
    failedChecks = failed ? failedChecks + 1 : 0;
    nextAutoCheckAt = failed
      ? Date.now() +
        Math.min(failedChecks + 1, MAX_BACKOFF_TICKS) * CHECK_INTERVAL_MS
      : 0;
  }
}

// True when the staged update is actually installable: manifest
// present, bundle on disk, and a different version than this build (a
// same-version manifest is debris from an install that crashed between
// swap and cleanup, and restarting into it would deliver nothing).
// When it's gone while the UI still says ready, resets to idle rather
// than leave a dead "Restart to update" button up until the next
// check.
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
async function installUpdate(unattended: boolean): Promise<void> {
  if (installing) return;
  if (!(await hasInstallableStaged())) return;
  if (unattended) {
    const refusal = busyActionRemoteRefusal("restart");
    if (refusal !== null) throw new Error(refusal);
  } else {
    if (!(await confirmBusyAction("restart"))) return;
    // The dialog can sit open arbitrarily long. Re-check that another
    // path didn't start the install during it, and that the staged
    // update still exists -- a terminal run whose feed answered 204
    // clears it, and quitting with nothing staged would be a quit the
    // installer can't follow with a relaunch.
    if (installing) return;
    if (!(await hasInstallableStaged())) return;
  }
  installing = true;
  try {
    // Resolves only once the installer actually spawned: quitting on a
    // child that failed to start would end the app without a relaunch.
    await spawnCliDetached([
      "update",
      "--finish-install",
      "--pid",
      String(process.pid),
    ]);
  } catch (err) {
    installing = false;
    setState({
      kind: "error",
      message: errorMessageOf(err),
    });
    // A remote caller reads success as "restarting", and Update all
    // restarts the asking machine on it, so the failure rides back.
    if (unattended) throw err;
    return;
  }
  // A peer's invoke is answered when this handler resolves, and quit
  // tears the direct listener down before a queued frame can leave, so
  // an unattended install returns first and quits a beat later. The
  // caller then sees success instead of a dropped-session error for an
  // update that is installing fine. `installing` blocks a second run
  // in the gap.
  if (unattended) {
    setTimeout(() => app.quit(), UNATTENDED_QUIT_DELAY_MS);
    return;
  }
  app.quit();
}

export function installUpdaterImpl(): void {
  setUpdaterImpl({
    getState: getUpdaterState,
    check: checkForUpdates,
    install: installUpdate,
  });
}

export function startUpdater(): void {
  if (started) return;
  if (!app.isPackaged) {
    // Publishes the state file too, so `sm update` reads "unsupported"
    // instead of waiting on a bridge that will never start.
    setState({ kind: "unsupported" });
    return;
  }
  started = true;
  // The only bridge request is "install" (UpdateRequestSchema). The
  // CLI runs at this machine's own terminal, so it is attended.
  startUpdaterBridge(() => void installUpdate(false));
  void (async () => {
    // Seed from disk before any network work: an update staged earlier
    // (a previous run, or `sm update --stage` in a terminal) is ready
    // immediately, no CLI spawn needed. The first check still runs, in
    // case a newer release has shipped since.
    const staged = await readInstallableStaged();
    if (staged !== null) setState(readyStateFrom(staged));
    setTimeout(checkForUpdates, FIRST_CHECK_DELAY_MS);
  })();
  // Runs for the app's lifetime. Quit tears the interval down with the
  // process, so there's no stop path.
  setInterval(() => {
    if (Date.now() >= nextAutoCheckAt) checkForUpdates();
  }, CHECK_INTERVAL_MS);
}
