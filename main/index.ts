import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { cliRootDirName } from "@shared/cliDist.mts";
import { DEV_BUILD_FLAG } from "@shared/devBuildFlag.mts";
import { DEVICE_ID_FLAG } from "@shared/deviceIdFlag.mts";
import { gitContract } from "@shared/ipc/modules/git";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { windowContract } from "@shared/ipc/modules/window";
import { ensureShigomoriRoot } from "@host/lib/bootstrap";
import { getDeviceId } from "@host/lib/config/deviceId";
import { attachContextMenu } from "./electron/contextMenu";
import { enableDevCdpPort } from "./electron/devCdp";
import {
  refreshAllProjectGitRefs,
  startBackgroundFetch,
} from "./electron/fetch";
import {
  applyThemeSource,
  readClientConfigSync,
} from "./electron/clientConfig";
import { seedClientConfigFromLegacy } from "./electron/clientConfigMigration";
import { registerIpcHandlers } from "./ipc";
import { installHostImpls } from "./electron/hostImpls";
import { buildAppMenu, installMenuImpl } from "./electron/menu";
import { broadcast, broadcastAll, refreshSocketHost } from "./ipc/register";
import {
  getInflightDeleteIds,
  killAllScripts,
  killScriptsForWorktree,
  markShuttingDown,
  signalAllScriptsBestEffort,
} from "@host/lib/scripts";
import { startOrphanScriptSweep } from "@host/lib/scripts/persistence";
import { reapScriptsForRemovedWorktrees } from "@host/lib/scripts/removedWorktrees";
import { initShigomoriRoot, shigomoriRoot } from "@host/lib/util/paths";
import { repairCliLinks } from "./electron/cliInstall";
import { killAllCli } from "./electron/cliRunner";
import { applyUserShellPath } from "./electron/shellPath";
import { startStateWatcher } from "./electron/stateWatcher";
import { confirmBusyActionSync } from "./electron/busyPrompt";
import { isRelaunching } from "./electron/relaunch";
import { errorMessageOf } from "@shared/errors";
import {
  installUpdaterImpl,
  isInstallingUpdate,
  startUpdater,
} from "./electron/updater";

enableDevCdpPort();

// Electron scopes the single-instance lock to the userData directory,
// and dev and packaged builds resolve the same one out of productName.
// A dev run owns a different data root (~/shigomori-dev), so give it
// its own userData or an installed copy would lock it out.
if (!app.isPackaged) {
  app.setPath("userData", `${app.getPath("userData")} (dev)`);
}

// One live instance per data root. A second copy (typically a fresh
// download in ~/Downloads beside the installed app) would run its own
// state watcher, background fetcher, updater and script registry over
// the same files. `app.exit` skips before-quit, so the losing process
// never reaches the quit sequence at the bottom of this file: it can't
// prompt about busy work, and it can't reap scripts that belong to the
// instance owning the root. It tells the user nothing, because raising
// the running window is what launching the app asked for.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

initShigomoriRoot(app.isPackaged);

// Electron-layer impls must be wired before registerIpcHandlers runs so
// the first renderer call never lands on the throwing default.
installMenuImpl();
installUpdaterImpl();
installHostImpls();
registerIpcHandlers();

let mainWindow: BrowserWindow | null = null;
// Set once the ready handler's own createWindow() call has run, so
// second-instance can tell "boot is still in flight" (nothing to do
// yet, that call is on its way) apart from "the window was closed
// after boot" (recreate it). Without this, a launch that lands during
// the ready handler's await (ensureShigomoriRoot on a slow or
// unreachable data folder) would see mainWindow still null, create a
// window itself, and then get a second one from the ready handler
// finishing right after.
let hasBooted = false;

// Read once in the ready handler (a corrupt registry throws there, into
// the boot error dialog). createWindow only interpolates it. Never
// empty by the time any window exists: getDeviceId mints or throws.
let deviceId = "";

const createWindow = () => {
  hasBooted = true;
  // Drive the native appearance from the saved theme before constructing
  // the window so the macOS vibrancy material picks the right light/dark
  // variant on first paint. Absent or "system" delegates back to the OS.
  applyThemeSource(readClientConfigSync().theme);
  mainWindow = new BrowserWindow({
    width: 920,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    // Inset traffic lights over a transparent shell so the
    // NSVisualEffectView material set via `vibrancy` shows through where
    // the renderer paints no background (the sidebar column).
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Synchronous delivery of the device id: the preload reads this
      // flag off process.argv and exposes it on the bridge, so the
      // renderer never has to gate key building behind an IPC call.
      // The id itself is read in the ready handler, whose try/catch
      // turns a corrupt registry into the error dialog instead of a
      // throw out of createWindow with no window.
      // The dev flag rides the same channel: isDev is a fact about this
      // client build, not the host, so it must not travel via
      // runtime.info.
      additionalArguments: [
        `${DEVICE_ID_FLAG}${deviceId}`,
        ...(app.isPackaged ? [] : [DEV_BUILD_FLAG]),
      ],
    },
  });

  // The renderer is a single local document with in-memory routing, so
  // no in-page navigation or popup is ever legitimate. External links go
  // through the scheme-validated shell:openExternal IPC instead. Same-URL
  // navigation stays allowed so the dev server's full reload still works.
  const webContents = mainWindow.webContents;
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, url) => {
    if (url !== webContents.getURL()) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Relay BrowserWindow focus/blur to the renderer. The web-level `focus`
  // and `visibilitychange` events don't fire on every Electron focus
  // transition (notably ⌘Tab between apps), so React Query's
  // refetch-on-focus needs this signal to be reliable.
  const sendFocus = () => {
    const wc = mainWindow?.webContents;
    if (wc) broadcast(windowContract, "focused", undefined, wc);
    refreshAllProjectGitRefs();
  };
  const sendBlur = () => {
    const wc = mainWindow?.webContents;
    if (wc) broadcast(windowContract, "blurred", undefined, wc);
  };
  mainWindow.on("focus", sendFocus);
  mainWindow.on("blur", sendBlur);

  attachContextMenu(mainWindow);
};

// Launching the app again while a copy runs is a request to see it, so
// surface the window we already have. It can be missing if the user
// closed it and then cancelled the quit that followed. Before the first
// boot-time createWindow() call, do nothing beyond the focus below: that
// call is already on its way, and racing it here would leave two windows
// open instead of one.
app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (hasBooted) {
    createWindow();
  }
  // macOS won't raise a background app just because one of its windows
  // asked for focus, and the launch the user just made is already gone.
  app.focus({ steal: true });
});

app.on("ready", async () => {
  // Packaged launches inherit launchd's stripped PATH; dev launches start
  // from the user's terminal and already have the right one.
  if (app.isPackaged) await applyUserShellPath();
  try {
    await ensureShigomoriRoot();
    deviceId = getDeviceId();
  } catch (err) {
    // A pointer file can aim the root somewhere that isn't reachable
    // right now (external drive unplugged, permissions changed). A
    // silent unhandled rejection here would leave the app running with
    // no window. Say what's wrong and how to recover instead.
    dialog.showErrorBox(
      "Shigoto no Mori can't access its data folder",
      `${shigomoriRoot()} could not be created or accessed.\n\n` +
        "If you moved the data folder to an external drive, reconnect " +
        "it and relaunch. To fall back to the default location, delete " +
        "the pointer file at ~/.config/" +
        `${cliRootDirName(app.isPackaged ? "prod" : "dev")}/root.\n\n` +
        `${errorMessageOf(err)}`,
    );
    app.exit(1);
    return;
  }
  // A crash, a force quit, or an OOM skips every kill path below, so
  // anything the last session left running is reaped here. Claims the
  // record file synchronously (before any script can spawn) and does
  // the killing in the background.
  startOrphanScriptSweep();
  // Before the first createWindow, whose theme read must already see
  // values migrated out of the pre-split device config.
  await seedClientConfigFromLegacy();
  buildAppMenu();
  createWindow();
  startBackgroundFetch();
  startUpdater();
  // Remote hosting (v2 step 3, slice A): serve host-scoped calls over
  // the LAN when the device config enables it. After getDeviceId so
  // the welcome frame's identity is final. The same reconcile reruns
  // after every globalConfig write (hostImpls wiring), making this the
  // boot-time pass only.
  void refreshSocketHost();
  // External CLI writes surface in the UI via an explicit invalidation
  // broadcast. (The focus signal won't do: React Query's focusManager
  // only refetches on a blur->focus transition, and the window may be
  // focused the whole time an agent works in a terminal beside it.)
  startStateWatcher(() => {
    broadcastAll(gitContract, "externalChange", undefined);
    // The same refresh is the app's only chance to notice an `sm rm`
    // run in a terminal: the CLI removes the worktree without knowing
    // the app exists, leaving any script the app started in it running
    // against a deleted cwd and still holding its port.
    void reapScriptsForRemovedWorktrees()
      .then((removed) => {
        for (const worktree of removed) {
          broadcastAll(scriptsContract, "stoppedForRemovedWorktree", {
            worktreeId: worktree.worktreeId,
            worktreeName: worktree.worktreeName,
            scriptCount: worktree.scriptCount,
          });
        }
      })
      .catch((err: unknown) => {
        console.warn(
          `[scripts] reap after external change failed: ${errorMessageOf(err)}`,
        );
      });
  });
  // Installing the CLI link is a Settings action; launch only repairs
  // an already-installed link whose target moved (app update, other
  // checkout). After applyUserShellPath so PATH checks see the login
  // shell's PATH.
  void repairCliLinks();
});

app.on("window-all-closed", () => {
  app.quit();
});

// Reap any scripts still running before Electron tears down. Without
// this, long-lived processes (dev servers, watchers) the user kicked
// off via a script keep running after Cmd-Q, orphaned to launchd.
//
// For in-flight deletes we kill only the cleanup scripts for those
// worktrees, leaving the worktree directory intact (safest partial
// state). Then we reap everything else with killAllScripts.
let isQuitting = false;
app.on("before-quit", (event) => {
  if (isQuitting) return;
  // An update-triggered quit has to flow through Electron's natural quit so
  // the detached `sm update --finish-install` installer sees this pid
  // exit and swaps bundles. Awaiting the full kill chain here would
  // block that handoff for up to ~1.5s (grace + SIGKILL). Instead we
  // fire a synchronous
  // best-effort SIGTERM to each process group, so well-behaved scripts
  // get the natural quit window ~100ms to clean up. The trade-off vs
  // the normal-quit path: children that survive the best-effort pass
  // don't get the escalation fallback and may end up orphaned.
  // Acceptable for an explicit, user-initiated update.
  if (isInstallingUpdate() || isRelaunching()) {
    markShuttingDown();
    signalAllScriptsBestEffort("SIGTERM");
    killAllCli();
    return;
  }
  // The install branch above has already gated its own restart via the
  // renderer-initiated installUpdate dialog, so it skips this prompt.
  if (!confirmBusyActionSync("quit")) {
    event.preventDefault();
    // When the user got here by closing the last window (close-X →
    // window-all-closed → app.quit()), the BrowserWindow is already
    // destroyed by the time before-quit fires. Restore it so the
    // canceled quit doesn't leave the app running headless with the
    // busy work still in progress. Cmd-Q / menu Quit reach before-quit
    // before any window is closed, so the recreate is a no-op there.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
    return;
  }
  isQuitting = true;
  markShuttingDown();
  event.preventDefault();
  // Backstop: if a kill chain wedges (unkillable child), don't leave
  // the app running headless after the window is gone.
  setTimeout(() => app.exit(1), 15_000);
  // CLI children (CLI-engine lifecycle operations) get the same reap as
  // scripts; the CLI's own children share its terminal-style process
  // group and follow it down.
  killAllCli();
  const inflight = getInflightDeleteIds();
  // allSettled: one rejected per-worktree kill must not skip the
  // killAllScripts pass for everything else.
  void Promise.allSettled(
    Array.from(inflight).map((id) => killScriptsForWorktree(id)),
  )
    .then(() => killAllScripts({ graceMs: 1_500 }))
    .finally(() => {
      // `app.exit` skips before-quit/will-quit, avoiding a re-entry loop.
      app.exit(0);
    });
});
