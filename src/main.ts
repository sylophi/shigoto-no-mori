import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import { CHANNELS } from "@shared/channels";
import { SetThemePayloadSchema, type Theme } from "@shared/schemas";
import { registerIpcHandlers } from "./main/ipc";
import { buildAppMenu } from "./main/menu";
import { readKey, writeKey } from "./main/store";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

registerIpcHandlers();

const THEME_KEY = "theme";
const BG_LIGHT = "#ffffff";
const BG_DARK = "#1c1c1c";

function resolvedBgColor(): string {
  const stored = readKey<Theme>(THEME_KEY, "system");
  const dark =
    stored === "dark" ||
    (stored === "system" && nativeTheme.shouldUseDarkColors);
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
    backgroundColor: resolvedBgColor(),
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
};

// Persist user-chosen theme so the next window can paint the right color
// before the renderer mounts. Also nudges the current window so OS-level
// chrome (titlebar, scrollbars) stays in sync after a theme change.
ipcMain.handle(CHANNELS.RuntimeSetTheme, (_event, rawPayload: unknown) => {
  const { theme } = SetThemePayloadSchema.parse(rawPayload);
  writeKey<Theme>(THEME_KEY, theme);
  if (mainWindow) mainWindow.setBackgroundColor(resolvedBgColor());
});

// React to OS theme changes when the user has chosen "system".
nativeTheme.on("updated", () => {
  if (!mainWindow) return;
  const stored = readKey<Theme>(THEME_KEY, "system");
  if (stored === "system") mainWindow.setBackgroundColor(resolvedBgColor());
});

app.on("ready", () => {
  buildAppMenu();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
