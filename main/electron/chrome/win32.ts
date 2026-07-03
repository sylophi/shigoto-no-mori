// Windows chrome: hidden title bar with native caption buttons overlaid
// top-right. There is no vibrancy equivalent that can follow the in-app
// theme, so the window is opaque and the renderer paints the sidebar
// surface itself (renderer/index.css branches on data-platform).
import { type BrowserWindow, nativeTheme } from "electron";
import type { PlatformChrome } from "./types";

// Colors follow the effective theme (nativeTheme already reflects the
// in-app choice via themeSource). The window background matches the
// renderer's `--background` tokens (white / neutral-900) so resize
// flashes blend in, and the title-bar overlay hosting the caption
// buttons matches the main pane it floats above. The sidebar surface on
// top of this shell is painted by renderer/index.css (the
// data-platform="win32" block) -- keep the two in the same family.
function chromeColors() {
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

function windowOptions(): Electron.BrowserWindowConstructorOptions {
  const { backgroundColor, overlay } = chromeColors();
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: overlay,
    backgroundColor,
  };
}

// Re-apply chrome colors when the theme changes (the renderer's setTheme
// IPC flips nativeTheme.themeSource; "system" follows the OS).
function attachThemeSync(getWindow: () => BrowserWindow | null): void {
  nativeTheme.on("updated", () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const { backgroundColor, overlay } = chromeColors();
    win.setBackgroundColor(backgroundColor);
    win.setTitleBarOverlay(overlay);
  });
}

export const win32Chrome: PlatformChrome = { windowOptions, attachThemeSync };
