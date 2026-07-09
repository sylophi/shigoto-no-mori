import { app, BrowserWindow, nativeTheme } from "electron";
import squirrelStartup from "electron-squirrel-startup";
import path from "node:path";
import { windowContract } from "@shared/ipc/modules/window";
import { ensureShigomoriRoot } from "./electron/bootstrap";
import { attachContextMenu } from "./electron/contextMenu";
import {
  refreshAllProjectGitRefs,
  startBackgroundFetch,
} from "./electron/fetch";
import { readThemeSync } from "./lib/config/global";
import { registerIpcHandlers } from "./ipc";
import { buildAppMenu, installMenuImpl } from "./electron/menu";
import { broadcast } from "./ipc/register";
import {
  getInflightDeleteIds,
  killAllScripts,
  killScriptsForWorktree,
  markShuttingDown,
  signalAllScriptsBestEffort,
} from "./lib/scripts";
import { initShigomoriRoot } from "./lib/util/paths";
import { isWindows } from "./lib/util/platform";
import { platformChrome } from "./electron/chrome";
import { applyUserShellPath } from "./electron/shellPath";
import { confirmBusyActionSync } from "./electron/busyPrompt";
import {
  installUpdaterImpl,
  isInstallingUpdate,
  startUpdater,
} from "./electron/updater";

// Squirrel.Windows relaunches the app with install/update/uninstall
// flags; electron-squirrel-startup handles the shortcut bookkeeping for
// those and returns true, in which case this process must exit without
// booting the app. No-op (false) everywhere but Windows.
if (squirrelStartup) {
  app.quit();
}

// Match the AppUserModelID Squirrel stamps on the Start-menu shortcut
// (com.squirrel.<nuget id>.<exe name>; the maker rewrites the package
// name's hyphens to underscores for the nuget id). Without this the
// running window doesn't group with the pinned shortcut on the taskbar.
// Verify against the shortcut's properties if the packaging ever
// changes.
if (isWindows) {
  app.setAppUserModelId("com.squirrel.shigoto_no_mori.shigoto-no-mori");
}

initShigomoriRoot(app.isPackaged);

// Electron-layer impls must be wired before registerIpcHandlers runs so
// the first renderer call never lands on the throwing default.
installMenuImpl();
installUpdaterImpl();
registerIpcHandlers();

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Drive the native appearance from the saved theme before constructing
  // the window so the macOS vibrancy material (or the Windows chrome
  // colors) picks the right light/dark variant on first paint. A value
  // of "system" delegates back to the OS.
  nativeTheme.themeSource = readThemeSync();
  mainWindow = new BrowserWindow({
    width: 920,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    ...platformChrome.windowOptions(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
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

// Keep native chrome in sync with theme changes where the OS doesn't do
// it on its own (Windows caption buttons + window background).
platformChrome.attachThemeSync(() => mainWindow);

app.on("ready", async () => {
  // Packaged launches inherit launchd's stripped PATH; dev launches start
  // from the user's terminal and already have the right one.
  if (app.isPackaged) await applyUserShellPath();
  await ensureShigomoriRoot();
  buildAppMenu();
  createWindow();
  startBackgroundFetch();
  startUpdater();
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
  // An update-triggered quit has to flow through Electron's natural
  // quit so Squirrel's ShipIt helper detects the parent PID exit and
  // swaps bundles. Awaiting the full kill chain here would block that
  // handoff for up to ~1.5s (grace + SIGKILL); instead we fire a
  // synchronous best-effort kill per platform: SIGTERM to each process
  // group on macOS (well-behaved scripts get the natural quit window
  // ~100ms to clean up), a detached forced taskkill on Windows (no
  // graceful channel exists there). The trade-off vs the normal-quit
  // path: children that survive the best-effort pass don't get the
  // escalation fallback and may end up orphaned. Acceptable for an
  // explicit, user-initiated update.
  if (isInstallingUpdate()) {
    markShuttingDown();
    signalAllScriptsBestEffort("SIGTERM");
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
  const inflight = getInflightDeleteIds();
  void Promise.all(Array.from(inflight).map((id) => killScriptsForWorktree(id)))
    .then(() => killAllScripts({ graceMs: 1_500 }))
    .finally(() => {
      // `app.exit` skips before-quit/will-quit, avoiding a re-entry loop.
      app.exit(0);
    });
});
