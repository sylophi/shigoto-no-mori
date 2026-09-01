// Host liveness (v2 step 4, slice E). One opt-in, `keepReachable` in
// client config, drives two capabilities so a machine the user hosts
// stays online for the account hub:
//   1. Launch-at-login, via setLoginItemSettings, so the app starts when
//      the user logs in.
//   2. Best-effort recovery from a recoverable crash: a renderer that
//      dies is recreated in-process, and a fatal main-process error does
//      a rate-limited relaunch.
// A true native hard-crash of the main process (a segfault) cannot be
// caught in-process and would need an OS supervisor (macOS launchd
// KeepAlive). That is out of scope here. The pruning and counting for
// both crash guards is the pure module main/liveness/rateLimit.ts, which
// scripts/check-liveness.mjs drives headlessly.
import { app, type BrowserWindow } from "electron";
import { platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errorMessageOf } from "@shared/errors";
import { markShuttingDown } from "@host/lib/scripts";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
} from "@host/lib/util/jsonFile";
import { readClientConfigSync } from "./clientConfig";
import { accountServiceConfigured } from "../ipc/modules/account";
import { markRelaunching } from "./relaunch";
import {
  shouldRecreateWindow,
  shouldRelaunchAfterFatal,
} from "../liveness/rateLimit";

function keepReachableEnabled(): boolean {
  // Inert on a build with no account service: the setting exists so a
  // machine stays available TO the account, its UI is unreachable when
  // the SM_ACCOUNT_* env is absent, and boot's reconcile clears a login
  // item left behind by a previously configured build.
  if (!accountServiceConfigured()) return false;
  try {
    return readClientConfigSync().keepReachable === true;
  } catch (error) {
    // A store read should never throw (the store's own read swallows
    // corruption), but a liveness decision must never be what crashes
    // the app, so treat an unreadable config as opted out.
    console.warn(
      `[liveness] could not read keepReachable, treating as off: ${errorMessageOf(error)}`,
    );
    return false;
  }
}

// (1) Launch-at-login. Reads the single opt-in and registers or clears
// the OS login item to match. Idempotent (setLoginItemSettings with the
// same value is a no-op) and never throws: it is called at boot and on
// every client-config write, and a liveness reconcile must not be able
// to take the app down. Called from boot in main/index.ts and from the
// clientConfig write handler.
export function reconcileLaunchAtLogin(): void {
  const keepReachable = keepReachableEnabled();
  // setLoginItemSettings is a no-op on Linux in Electron, so registering
  // there would silently do nothing. Say so rather than pretend it took.
  // os.platform() is the same value as the lint-restricted
  // process.platform (see main/ipc/modules/account.ts).
  const os = platform();
  if (os !== "darwin" && os !== "win32") {
    console.info(
      `[liveness] launch-at-login is unsupported on ${os}, skipping (keepReachable=${keepReachable})`,
    );
    return;
  }
  // A dev build must not install a login item: it would point at the
  // Electron binary under node_modules and relaunch a throwaway dev
  // instance at every login. Register only from packaged builds, where
  // the login item points at the real installed app.
  if (!app.isPackaged) {
    console.info(
      `[liveness] dev build, not touching the login item (keepReachable=${keepReachable})`,
    );
    return;
  }
  try {
    app.setLoginItemSettings({ openAtLogin: keepReachable });
  } catch (error) {
    console.error(
      `[liveness] setLoginItemSettings failed: ${errorMessageOf(error)}`,
    );
  }
}

// (2a) Renderer crash recovery. Timestamps of the recreations this
// process has performed, kept in memory across recreations so the loop
// guard sees the whole burst. A fresh app process starts with an empty
// list, which is correct: a crash right after launch is not a loop.
let recentRendererCrashes: number[] = [];

// Reasons a render-process-gone event means an intended teardown rather
// than a crash to recover from. "clean-exit" is a normal exit, "killed"
// is a deliberate kill (typically during our own shutdown).
const INTENTIONAL_GONE_REASONS = new Set(["clean-exit", "killed"]);

// Attach the renderer-crash and unresponsive handlers to a window. Called
// from createWindow for every window, including the ones recreated after
// a crash, so a second crash lands on a live handler too. The recreate
// budget is shared module state, so re-attaching does not reset it.
export function attachRenderProcessRecovery(
  window: BrowserWindow,
  deps: {
    isShuttingDown: () => boolean;
    recreateWindow: () => void;
    onGiveUp: () => void;
  },
): void {
  const webContents = window.webContents;
  webContents.on("render-process-gone", (_event, details) => {
    // Never recreate while the app is tearing down: the renderer going
    // away is expected there, and a recreate would fight the quit.
    if (deps.isShuttingDown()) return;
    if (INTENTIONAL_GONE_REASONS.has(details.reason)) {
      console.info(
        `[liveness] renderer exited (${details.reason}), not recreating`,
      );
      return;
    }
    const { recreate, recent } = shouldRecreateWindow(
      recentRendererCrashes,
      Date.now(),
    );
    recentRendererCrashes = recent;
    if (recreate) {
      console.error(
        `[liveness] renderer gone (${details.reason}), recreating the window`,
      );
      deps.recreateWindow();
    } else {
      console.error(
        `[liveness] renderer crash loop (${details.reason}), giving up to avoid thrashing`,
      );
      deps.onGiveUp();
    }
  });
  // Not a crash: the renderer is alive but wedged. Log it so a hang is
  // visible in the console rather than a silent frozen window.
  webContents.on("unresponsive", () => {
    console.warn("[liveness] renderer is unresponsive");
  });
  webContents.on("responsive", () => {
    console.info("[liveness] renderer became responsive again");
  });
}

// GPU and utility (child) processes. The app usually survives these and
// Electron respawns the GPU process on its own, so this only logs.
// Registered once at boot, since it is an app-level event.
export function installChildProcessLogging(): void {
  app.on("child-process-gone", (_event, details) => {
    console.warn(
      `[liveness] child process gone: type=${details.type} reason=${details.reason}`,
    );
  });
}

// (2b) Fatal main-process recovery. The relaunch budget is persisted in
// userData because a relaunch restarts the process: an in-memory counter
// would reset on every respawn and could not stop a deterministic
// startup crash from looping forever.
function relaunchMarkerPath(): string {
  return join(app.getPath("userData"), "livenessRelaunch.json");
}

// Read the recent-relaunch timestamps, ask the rate limiter whether one
// more is allowed, and if so persist the appended list before returning
// true. Read and write go through the shared atomic-json helpers so the
// write is temp-plus-rename atomic: this runs right before app.exit, so a
// raw write could be truncated by the exit mid-flush. A marker that
// cannot be READ is treated as no recent relaunches (fine: a marker that
// cannot be WRITTEN vetoes the relaunch just below, so an unwritable
// userData can never loop).
function consumeRelaunchBudget(now: number): boolean {
  let recent: number[] = [];
  try {
    recent =
      readJsonOrNullSync(relaunchMarkerPath(), z.array(z.number())) ?? [];
  } catch {
    // Missing, unreadable, or corrupt marker: no known recent relaunches.
    // The next successful write re-accumulates from empty.
  }
  const { relaunch, recent: next } = shouldRelaunchAfterFatal(recent, now);
  if (!relaunch) return false;
  try {
    // 0o600: the marker lives in userData beside other per-user state and
    // holds nothing secret, but there is no reason to widen it.
    // selfWrite:false because userData sits outside the watched
    // shigomori root, so a self-write claim here would only blind the
    // state watcher to a genuine external write for the echo window.
    atomicWriteJsonSync(relaunchMarkerPath(), next, {
      mode: 0o600,
      selfWrite: false,
    });
  } catch (error) {
    console.error(
      `[liveness] could not persist the relaunch marker, not relaunching: ${errorMessageOf(error)}`,
    );
    return false;
  }
  return true;
}

// Install the last-resort handlers for an otherwise-fatal main-process
// error. Conservative by design: a wrong relaunch is worse than none, so
// a relaunch happens only when the user opted into keepReachable, only
// when the app is not already shutting down, and only within the
// persisted rate limit. When those do not hold the process still exits
// (see below): installing a listener suppresses the default crash, so it
// must terminate explicitly rather than swallow the error. Registered
// once at boot.
export function installFatalRecovery(deps: {
  isShuttingDown: () => boolean;
}): void {
  // Best-effort, opt-in, rate-limited relaunch. Returns true when it has
  // scheduled a relaunch (the caller then exits so the fresh instance
  // takes over), false when no relaunch is warranted (not opted in, or
  // the budget is exhausted) so the caller still exits to preserve the
  // prior crash-and-exit behavior.
  const tryRelaunch = (): boolean => {
    // The opt-in gate. On a normal user's machine a stray uncaught error
    // must not become a restart, so respawn only a machine the user
    // asked to keep reachable.
    if (!keepReachableEnabled()) return false;
    if (!consumeRelaunchBudget(Date.now())) {
      console.error(
        "[liveness] fatal-relaunch rate limit reached, letting the crash stand",
      );
      return false;
    }
    console.error(
      "[liveness] keepReachable is on, attempting a best-effort relaunch",
    );
    try {
      // Mark relaunching first so if before-quit somehow fires it takes
      // index.ts's fast reap path rather than the busy-action prompt.
      markRelaunching();
      markShuttingDown();
      app.relaunch();
    } catch (error) {
      console.error(
        `[liveness] scheduling the relaunch failed: ${errorMessageOf(error)}`,
      );
    }
    return true;
  };
  process.on("uncaughtException", (error) => {
    console.error("[liveness] uncaughtException:", error);
    // A process uncaughtException listener suppresses Node and Electron's
    // default crash-and-exit, so this branch must exit explicitly to
    // preserve prior behavior: an uncaught main-process error still
    // terminates the app rather than leaving it limping on in an
    // undefined state (and hiding real crashes in dev). The one exception
    // is a teardown already in progress, where the process is on its way
    // out and a return is correct.
    if (deps.isShuttingDown()) return;
    // Schedule the relaunch when opted in and within budget; either way
    // the process must exit, since it is in an undefined state after an
    // uncaught error. exit(1) rather than quit(): skip the graceful quit
    // chain (which could itself be what threw). With a relaunch scheduled
    // the fresh instance takes over; with none this is exactly the
    // terminate the default handler would have done.
    tryRelaunch();
    app.exit(1);
  });
  // Unhandled rejections are treated as recoverable: a stray hub
  // reconnect, fetch, or updater promise without a .catch is frequently
  // non-fatal, so only a genuinely fatal uncaughtException relaunches.
  // Logging here intentionally suppresses a rejection-triggered process
  // crash in favor of a console line, which is the right posture for a
  // desktop app the user is hosting.
  process.on("unhandledRejection", (reason) => {
    console.error("[liveness] unhandledRejection:", reason);
  });
}
