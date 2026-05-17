import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import { CHANNELS } from "@shared/channels";
import { SetThemePayloadSchema, type Theme } from "@shared/schemas";
import { ensureShigomoriRoot } from "./main/bootstrap";
import { readThemeSync } from "./main/globalConfig";
import { registerIpcHandlers } from "./main/ipc";
import { buildAppMenu } from "./main/menu";
import {
  getInflightDeleteIds,
  killAllScripts,
  killScriptsForWorktree,
  markShuttingDown,
} from "./main/scripts";
import { applyUserShellPath } from "./main/shellPath";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

registerIpcHandlers();

const BG_LIGHT = "#ffffff";
const BG_DARK = "#1c1c1c";

function bgFor(theme: Theme): string {
  const dark =
    theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? BG_DARK : BG_LIGHT;
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: bgFor(readThemeSync()),
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
  const sendFocus = () => mainWindow?.webContents.send(CHANNELS.WindowFocused);
  const sendBlur = () => mainWindow?.webContents.send(CHANNELS.WindowBlurred);
  mainWindow.on("focus", sendFocus);
  mainWindow.on("blur", sendBlur);
};

// Live-update the window background as the renderer applies a theme
// (including unsaved previews). The persistent value lives in
// ~/shigomori[-dev]/config.json and is written by the renderer through
// the globalConfig IPC; main only reads it back at next launch.
ipcMain.handle(CHANNELS.RuntimeSetTheme, (_event, rawPayload: unknown) => {
  const { theme } = SetThemePayloadSchema.parse(rawPayload);
  if (mainWindow) mainWindow.setBackgroundColor(bgFor(theme));
});

// React to OS theme changes when the saved theme is "system".
nativeTheme.on("updated", () => {
  if (!mainWindow) return;
  const stored = readThemeSync();
  if (stored === "system") mainWindow.setBackgroundColor(bgFor(stored));
});

app.on("ready", async () => {
  // Packaged launches inherit launchd's stripped PATH; dev launches start
  // from the user's terminal and already have the right one.
  if (app.isPackaged) await applyUserShellPath();
  await ensureShigomoriRoot();
  buildAppMenu();
  createWindow();
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
