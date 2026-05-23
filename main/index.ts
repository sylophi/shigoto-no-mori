import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { CHANNELS } from "@shared/channels";
import { SetThemePayloadSchema } from "@shared/schemas";
import { ensureShigomoriRoot } from "./app/bootstrap";
import { attachContextMenu } from "./app/contextMenu";
import { refreshAllProjectGitRefs, startBackgroundFetch } from "./app/fetch";
import { readThemeSync } from "./config/global";
import { registerIpcHandlers } from "./ipc";
import { buildAppMenu } from "./app/menu";
import {
  Script,
  getInflightDeleteIds,
  markShuttingDown,
  signalAllScriptsBestEffort,
  runScriptProgram,
} from "./scripts";
import { applyUserShellPath } from "./app/shellPath";
import { isInstallingUpdate, startUpdater } from "./app/updater";

registerIpcHandlers();

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Drive AppKit appearance from the saved theme before constructing
  // the window so the NSVisualEffectView material under `vibrancy`
  // picks the right light/dark variant on first paint. Without this,
  // vibrancy stays glued to the OS appearance regardless of the in-app
  // theme; a value of "system" delegates back to the OS.
  nativeTheme.themeSource = readThemeSync();
  mainWindow = new BrowserWindow({
    width: 920,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    // Transparent shell so the macOS NSVisualEffectView material set via
    // `vibrancy` shows through the regions where the renderer paints no
    // background (currently just the sidebar column).
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
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
    mainWindow?.webContents.send(CHANNELS.WindowFocused);
    refreshAllProjectGitRefs();
  };
  const sendBlur = () => mainWindow?.webContents.send(CHANNELS.WindowBlurred);
  mainWindow.on("focus", sendFocus);
  mainWindow.on("blur", sendBlur);

  attachContextMenu(mainWindow);
};

// Track the renderer's applied theme (including unsaved previews) so
// the vibrancy material follows the in-app appearance rather than the
// OS one. The persistent value lives in ~/shigomori[-dev]/config.json
// and is written by the renderer through the globalConfig IPC.
ipcMain.handle(CHANNELS.RuntimeSetTheme, (_event, rawPayload: unknown) => {
  const { theme } = SetThemePayloadSchema.parse(rawPayload);
  nativeTheme.themeSource = theme;
});

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
  isQuitting = true;
  markShuttingDown();
  event.preventDefault();
  const inflight = getInflightDeleteIds();
  void Promise.all(
    Array.from(inflight).map((id) =>
      runScriptProgram(Script.killForWorktree(id)),
    ),
  )
    .then(() => runScriptProgram(Script.killAll({ graceMs: 1_500 })))
    .finally(() => {
      // `app.exit` skips before-quit/will-quit, avoiding a re-entry loop.
      app.exit(0);
    });
});
