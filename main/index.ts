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

initShigomoriRoot(app.isPackaged);

// Electron-layer impls must be wired before registerIpcHandlers runs so
// the first renderer call never lands on the throwing default.
installMenuImpl();
installUpdaterImpl();
registerIpcHandlers();

let mainWindow: BrowserWindow | null = null;

const isWindowsOS = process.platform === "win32";

// Windows chrome colors follow the effective theme (nativeTheme already
// reflects the in-app choice via themeSource). The window background
// matches the renderer's `--background` tokens (white / neutral-900) so
// resize flashes blend in, and the title-bar overlay hosting the caption
// buttons matches the main pane it floats above.
function windowsChromeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    backgroundColor: dark ? "#171717" : "#ffffff",
    overlay: {
      color: dark ? "#171717" : "#ffffff",
      symbolColor: dark ? "#fafafa" : "#171717",
      // Matches the h-7 drag strip the renderer lays across the top of
      // the main pane, so the caption buttons and the draggable band
      // form one continuous title-bar area.
      height: 28,
    },
  };
}

// macOS: inset traffic lights over a transparent shell so the
// NSVisualEffectView material set via `vibrancy` shows through where the
// renderer paints no background (the sidebar column). Windows: hidden
// title bar with native caption buttons overlaid top-right; there is no
// vibrancy equivalent that can follow the in-app theme, so the window is
// opaque and the renderer paints the sidebar surface itself (index.css
// branches on data-platform).
function platformWindowOptions(): Electron.BrowserWindowConstructorOptions {
  if (isWindowsOS) {
    const { backgroundColor, overlay } = windowsChromeColors();
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: overlay,
      backgroundColor,
    };
  }
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "active",
  };
}

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
    ...platformWindowOptions(),
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

// Keep the Windows chrome in sync with theme changes (the renderer's
// setTheme IPC flips nativeTheme.themeSource; "system" follows the OS).
// macOS needs nothing here -- AppKit re-tints the vibrancy material on
// its own.
if (isWindowsOS) {
  nativeTheme.on("updated", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { backgroundColor, overlay } = windowsChromeColors();
    mainWindow.setBackgroundColor(backgroundColor);
    mainWindow.setTitleBarOverlay(overlay);
  });
}

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
  // handoff for up to ~1.5s (grace + SIGKILL); instead we fire SIGTERM
  // to every script's process group synchronously and let the natural
  // quit window (~100ms) give well-behaved scripts a chance to clean
  // up. The trade-off vs the normal-quit path: misbehaving children
  // don't get the SIGKILL fallback and may end up reparented to
  // launchd. Acceptable for an explicit, user-initiated update.
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
