// Host liveness. One switch, `keepReachable` in client config (on
// unless switched off), keeps a machine the user hosts online for the
// device hub:
//   1. Launch-at-login, so the app starts when the user logs in.
//   2. Best-effort recovery from a recoverable crash: a renderer that
//      dies is recreated in-process, and a fatal main-process error does
//      a rate-limited relaunch (core/liveness/rateLimit.ts).
// A native hard crash of the main process (a segfault) cannot be caught
// in-process and would need an OS supervisor (launchd KeepAlive), which
// is out of scope.
import { clientSetting } from "@shigomori/contracts/schemas/config";
import { app, type BrowserWindow } from "electron";
import { platform } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
} from "../core/files/exitFiles";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { clientConfigChanges, readClientConfigSync } from "./clientConfig";
import {
  accountIdChanges,
  accountServiceConfigured,
  accountSignedIn,
} from "./account";
import { scheduleRelaunch } from "./relaunch";
import { rememberVisibilityForRestart } from "./restartVisibility";
import {
  FATAL_RELAUNCH,
  relaunchAllowed,
  rendererGone,
} from "../core/liveness/rateLimit";
import { log } from "@shared/log";
import { names } from "../flavor";

// Inert on a build with no account service: the setting exists so a
// machine stays available to the account, and its UI is unreachable
// without one.
const keepReachableEnabled = (): boolean =>
  accountServiceConfigured() &&
  clientSetting(readClientConfigSync(), "keepReachable");

// A dev build must not install a login item: it would point at the
// Electron binary under node_modules and relaunch a throwaway dev
// instance at every login. Register only from packaged builds, where
// the login item points at the real installed app. A test flavor's
// bundle is thrown away after its test, so it leaves no login item
// behind either.
export const setsLoginItem = (): boolean => app.isPackaged && !names.debuggable;

// (1) Launch-at-login, registered or cleared to match keepReachable and
// the account: the login item is for staying reachable to an account,
// so a signed-out device has none (the crash relaunch below keeps the
// plain setting: a relaunch is this machine's business whatever the
// account). Never throws, since a liveness reconcile must not be able
// to take the app down.
function reconcileLaunchAtLogin(): void {
  const keepReachable = keepReachableEnabled() && accountSignedIn();
  // setLoginItemSettings is a no-op on Linux in Electron, so registering
  // there would silently do nothing. Say so rather than pretend it took.
  const os = platform();
  if (os !== "darwin" && os !== "win32") {
    log.info(
      `[liveness] launch-at-login is unsupported on ${os}, skipping (keepReachable=${keepReachable})`,
    );
    return;
  }
  if (!setsLoginItem()) {
    log.info(
      `[liveness] dev or test build, not touching the login item (keepReachable=${keepReachable})`,
    );
    return;
  }
  try {
    app.setLoginItemSettings({ openAtLogin: keepReachable });
  } catch (error) {
    log.error(
      `[liveness] setLoginItemSettings failed: ${errorMessageOf(error)}`,
    );
  }
}

// The login item, reconciled as the shell's graph comes up (clearing
// one a previously configured build left), and again as keepReachable
// or the account changes.
export const loginItemLayer = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.suspend(() =>
      Stream.merge(
        clientConfigChanges.pipe(
          Stream.map((config) => clientSetting(config, "keepReachable")),
          Stream.changes,
        ),
        accountIdChanges,
      ).pipe(Stream.runForEach(() => Effect.sync(reconcileLaunchAtLogin))),
    ),
  ),
);

// (2a) Renderer crash recovery: when this process recreated a window,
// kept across recreations so the loop guard sees the whole burst.
let recentRendererCrashes: number[] = [];
let lastGiveUp: number | undefined;

// For every window, including the ones recreated after a crash.
export function attachRenderProcessRecovery(
  window: BrowserWindow,
  deps: {
    isShuttingDown: () => boolean;
    recreateWindow: () => void;
    // Whether to say so: once for every window one kill took.
    onGiveUp: (sayIt: boolean) => void;
  },
): void {
  const webContents = window.webContents;
  const id = webContents.id;
  let closing = false;
  window.on("close", () => {
    closing = true;
  });
  webContents.on("render-process-gone", (_event, details) => {
    const now = performance.now();
    const { verdict, recent } = rendererGone({
      ownTeardown: deps.isShuttingDown() || closing || window.isDestroyed(),
      recent: recentRendererCrashes,
      now,
      lastGiveUp,
    });
    recentRendererCrashes = recent;
    if (verdict === "ignore") return;
    if (verdict === "recreate") {
      log.error(
        `[liveness] window ${id}'s renderer gone (${details.reason}), recreating the window`,
      );
      deps.recreateWindow();
    } else {
      log.error(
        `[liveness] window ${id}'s renderer gone (${details.reason}) again, a crash loop: giving up to avoid thrashing`,
      );
      lastGiveUp = now;
      deps.onGiveUp(verdict === "give-up");
      // Its dialog blocks, and the gone windows' events wait behind it:
      // they are still the same kill once it is dismissed.
      lastGiveUp = performance.now();
    }
  });
  // Not a crash: the renderer is alive but wedged.
  webContents.on("unresponsive", () => {
    log.warn("[liveness] renderer is unresponsive");
  });
  webContents.on("responsive", () => {
    log.info("[liveness] renderer became responsive again");
  });
}

// GPU and utility (child) processes. The app usually survives these and
// Electron respawns the GPU process on its own, so this only logs.
export function installChildProcessLogging(): void {
  app.on("child-process-gone", (_event, details) => {
    log.warn(
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

// Whether one more relaunch is allowed since the last stable run, the
// count kept before it says so. The write is the exit path's (this runs
// right before app.exit). A marker that can't be read counts none; one
// that can't be written vetoes the relaunch, so an unwritable userData
// can never loop.
const RelaunchMarkerSchema = Schema.Struct({ relaunches: Schema.Int });

function consumeRelaunchBudget(): boolean {
  let relaunches = 0;
  try {
    relaunches =
      readJsonOrNullSync(relaunchMarkerPath(), RelaunchMarkerSchema)
        ?.relaunches ?? 0;
  } catch {
    // None known.
  }
  if (!relaunchAllowed(relaunches)) return false;
  try {
    atomicWriteJsonSync(
      relaunchMarkerPath(),
      { relaunches: relaunches + 1 },
      { mode: 0o600 },
    );
  } catch (error) {
    log.error(
      `[liveness] could not persist the relaunch marker, not relaunching: ${errorMessageOf(error)}`,
    );
    return false;
  }
  return true;
}

// Whether a relaunch is scheduled, for the caller to exit into. A wrong
// relaunch is worse than none: on a machine the user didn't ask to keep
// reachable a stray uncaught error must not become a restart, and the
// relaunches are rate-limited.
export function tryFatalRelaunch(rememberWindows: () => void): boolean {
  if (!keepReachableEnabled()) return false;
  if (!consumeRelaunchBudget()) {
    log.error(
      "[liveness] fatal-relaunch rate limit reached, letting the crash stand",
    );
    return false;
  }
  log.error(
    "[liveness] keepReachable is on, attempting a best-effort relaunch",
  );
  try {
    // First, so a quit that somehow starts is a hurried one.
    scheduleRelaunch();
    rememberWindows();
    rememberVisibilityForRestart();
  } catch (error) {
    log.error(
      `[liveness] scheduling the relaunch failed: ${errorMessageOf(error)}`,
    );
  }
  return true;
}

// The last-resort handlers for an otherwise-fatal main-process error.
export function installFatalRecovery(deps: {
  isShuttingDown: () => boolean;
  // The windows to bring back, as a quit remembers them.
  rememberWindows: () => void;
}): void {
  // A run this long was no crash loop: the relaunches before it are
  // forgotten.
  setTimeout(() => {
    try {
      rmSync(relaunchMarkerPath(), { force: true });
    } catch (error) {
      log.warn("[liveness] could not forget the relaunches:", error);
    }
  }, FATAL_RELAUNCH.stableMs).unref();
  process.on("uncaughtException", (error) => {
    log.error("[liveness] uncaughtException:", error);
    // The listener suppresses the default crash, so the app exits itself
    // rather than limp on in an undefined state, unless a teardown is
    // already taking it out. exit(1), not quit(): the graceful quit
    // could itself be what threw.
    if (deps.isShuttingDown()) return;
    tryFatalRelaunch(deps.rememberWindows);
    app.exit(1);
  });
  // A stray rejection is usually non-fatal, so it is logged in place of
  // the crash it would cause.
  process.on("unhandledRejection", (reason) => {
    log.error("[liveness] unhandledRejection:", reason);
  });
}
