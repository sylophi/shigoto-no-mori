// In-app updates, with the CLI as the engine. The app no longer embeds
// an updater at all (Squirrel is gone): checking shells out to
// `sm update --stage --json` (cli/updater.go), which queries the feed,
// downloads, signature-verifies, and parks the new bundle in
// <root>/updates/staged. Installing spawns a detached
// `sm update --finish-install --pid <ours>` and quits. The installer
// waits for this process to exit, swaps the bundle, and relaunches.
// The renderer sees the same small state machine as before.
//
// The staged manifest on disk is the source of truth for "there is an
// update to restart into" -- a terminal `sm update` may have staged it
// without this process's state machine ever leaving idle -- so boot
// seeds from the manifest and the install path re-checks it.
//
// macOS-only: the Windows build is a portable zip with no install
// location to swap, and dev builds run from a checkout. Both report
// `unsupported` so the renderer hides the check button.
//
// `SHIGOMORI_UPDATE_FEED_URL` still overrides the feed for end-to-end
// testing of a signed build -- the CLI child inherits it from our
// environment.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { updaterContract } from "@shared/ipc/modules/updater";
import type { StagedManifest, UpdaterState } from "@shared/schemas";
import {
  StagedManifestSchema,
  UpdateStageEventSchema,
  UpdateStageResultSchema,
} from "@shared/schemas";
import { setUpdaterImpl } from "../ipc/modules/updater";
import { broadcastAll } from "../ipc/register";
import { readJsonOrNull } from "../lib/util/jsonFile";
import { shigomoriRoot } from "../lib/util/paths";
import { isMac } from "../lib/util/platform";
import { confirmBusyAction } from "./busyPrompt";
import {
  cliAvailable,
  cliFailureMessage,
  runCli,
  spawnCliDetached,
} from "./cliRunner";
import { publishUpdaterState, startUpdaterBridge } from "./updaterBridge";

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
const stagedDir = () => join(shigomoriRoot(), "updates", "staged");

// null unless a well-formed manifest describes a bundle that is
// actually on disk.
async function readStagedManifest(): Promise<StagedManifest | null> {
  const manifest = await readJsonOrNull(
    join(stagedDir(), "manifest.json"),
    StagedManifestSchema,
  ).catch(() => null);
  if (manifest === null) return null;
  try {
    await stat(join(stagedDir(), manifest.bundleName));
  } catch {
    return null;
  }
  return manifest;
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

// One check at a time. Once an update is staged ("ready") the only
// useful action left is install, so further checks no-op until the
// restart. The CLI holds its own cross-process staging lock, so a
// terminal `sm update` racing this check is also safe -- the loser
// reports "update-in-progress" and is treated as a skip, not an error.
async function runCheck(): Promise<void> {
  if (!started || checkInFlight) return;
  if (state.kind === "downloading" || state.kind === "ready") return;
  checkInFlight = true;
  setState({ kind: "checking" });
  let failed = false;
  try {
    const result = await runCli(
      ["update", "--stage"],
      (doc) => {
        // "verifying" arrives too, and the renderer's machine collapses
        // everything between "found one" and "staged" into downloading.
        if (
          UpdateStageEventSchema.safeParse(doc).success &&
          state.kind !== "downloading"
        ) {
          setState({ kind: "downloading" });
        }
      },
      undefined,
      { background: true, timeoutMs: STAGE_TIMEOUT_MS },
    );
    const final = result.docs.findLast((doc) => typeof doc["ok"] === "boolean");
    const parsed =
      final?.["ok"] === true ? UpdateStageResultSchema.safeParse(final) : null;
    if (parsed?.success === true && parsed.data.status === "staged") {
      setState(readyStateFrom(parsed.data));
    } else if (
      (parsed?.success === true && parsed.data.status === "up-to-date") ||
      // A terminal `sm update` holding the staging lock is its turn,
      // not an error.
      final?.["code"] === "update-in-progress"
    ) {
      setState({ kind: "idle" });
    } else {
      failed = true;
      setState({
        kind: "error",
        message: cliFailureMessage(result, "Update check failed"),
      });
    }
  } catch (err) {
    failed = true;
    setState({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
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
// swap and cleanup -- restarting into it would deliver nothing). When
// it's gone while the UI still says ready, resets to idle: runCheck
// refuses to run while ready, so nothing else would ever revive the
// dead "Restart to update" button.
async function hasInstallableStaged(): Promise<boolean> {
  const staged = await readStagedManifest();
  if (staged !== null && staged.version !== app.getVersion()) return true;
  if (state.kind === "ready") setState({ kind: "idle" });
  return false;
}

// The install handoff, shared by Settings and the CLI's bridge
// request: verify something really is staged (the disk manifest, not
// this process's possibly-stale state machine), confirm with the user
// if scripts are running, then spawn the detached installer and quit.
async function installUpdate(): Promise<void> {
  if (installing) return;
  if (!(await hasInstallableStaged())) return;
  if (!(await confirmBusyAction("restart"))) return;
  // The dialog can sit open arbitrarily long. Re-check that another
  // path didn't start the install during it, and that the staged
  // update still exists -- a terminal run whose feed answered 204
  // clears it, and quitting with nothing staged would be a quit the
  // installer can't follow with a relaunch.
  if (installing) return;
  if (!(await hasInstallableStaged())) return;
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
      message: err instanceof Error ? err.message : String(err),
    });
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
  if (!isMac || !app.isPackaged || !cliAvailable()) {
    // Publishes the state file too, so `sm update` reads "unsupported"
    // instead of waiting on a bridge that will never start.
    setState({ kind: "unsupported" });
    return;
  }
  started = true;
  // The only bridge request is "install" (UpdateRequestSchema).
  startUpdaterBridge(() => void installUpdate());
  void (async () => {
    // Seed from disk before any network work: an update staged earlier
    // (a previous run, or `sm update --stage` in a terminal) is ready
    // immediately, no CLI spawn needed. A manifest matching our own
    // version is debris from an install that crashed between swap and
    // cleanup -- offering it would restart-loop into the same version.
    // The CLI clears it on its next stage run.
    const staged = await readStagedManifest();
    if (staged !== null && staged.version !== app.getVersion()) {
      setState(readyStateFrom(staged));
      return;
    }
    setTimeout(checkForUpdates, FIRST_CHECK_DELAY_MS);
  })();
  // Runs for the app's lifetime. Quit tears the interval down with the
  // process, so there's no stop path.
  setInterval(() => {
    if (Date.now() >= nextAutoCheckAt) checkForUpdates();
  }, CHECK_INTERVAL_MS);
}
