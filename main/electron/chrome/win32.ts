// Windows chrome: hidden title bar with native caption buttons overlaid
// top-right. There is no vibrancy equivalent that can follow the in-app
// theme, so the window is opaque and the renderer paints the sidebar
// surface itself (renderer/index.css branches on data-platform).
import { join } from "node:path";
import { app, type BrowserWindow, nativeTheme } from "electron";
import { isDoubutsu, onAppearanceChange } from "../appearance";
import type { PlatformChrome } from "./types";

// Colors follow the effective appearance (nativeTheme already reflects
// the in-app theme via themeSource; doubutsu arrives via the appearance
// module). The window background matches the renderer's `--background`
// token so resize flashes blend in, and the title-bar overlay hosting
// the caption buttons matches the surface it floats above: the plain
// main pane in v1, the card-tinted headers in doubutsu. Doubutsu hexes
// are the renderer/doubutsu.css background/card/foreground tokens
// converted to sRGB -- `pnpm check:theme` recomputes them from the CSS
// and fails if these drift, printing the expected values. The sidebar
// surface on top of this shell is painted by the renderer (index.css /
// doubutsu.css).
function chromeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  const height = 28; // matches the renderer's h-7 drag strip
  if (isDoubutsu()) {
    return dark
      ? {
          backgroundColor: "#1c1a16",
          overlay: { color: "#33302b", symbolColor: "#f0ebe4", height },
        }
      : {
          backgroundColor: "#faf6ee",
          overlay: { color: "#fffcf6", symbolColor: "#544129", height },
        };
  }
  return {
    backgroundColor: dark ? "#171717" : "#ffffff",
    overlay: {
      color: dark ? "#171717" : "#ffffff",
      symbolColor: dark ? "#fafafa" : "#171717",
      height,
    },
  };
}

function windowOptions(): Electron.BrowserWindowConstructorOptions {
  const { backgroundColor, overlay } = chromeColors();
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: overlay,
    backgroundColor,
    // Without this Electron still draws the menu-bar row in the client
    // area despite the hidden title bar; Alt reveals it on demand.
    autoHideMenuBar: true,
    // Dev only: packaged builds embed the icon in the exe (rcedit via
    // packagerConfig.icon), but `electron-forge start` would show the
    // stock Electron icon in the taskbar without an explicit one.
    ...(app.isPackaged
      ? {}
      : { icon: join(app.getAppPath(), "assets", "icon.ico") }),
  };
}

// Re-apply chrome colors when the appearance changes: nativeTheme
// "updated" fires for theme flips (the renderer's setTheme IPC drives
// themeSource; "system" follows the OS), and the appearance module
// fires for doubutsu toggles.
function attachThemeSync(getWindow: () => BrowserWindow | null): void {
  const apply = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const { backgroundColor, overlay } = chromeColors();
    win.setBackgroundColor(backgroundColor);
    win.setTitleBarOverlay(overlay);
  };
  nativeTheme.on("updated", apply);
  onAppearanceChange(apply);
}

export const win32Chrome: PlatformChrome = { windowOptions, attachThemeSync };
