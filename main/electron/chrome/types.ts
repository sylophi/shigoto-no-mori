// Shared shape for the per-platform window chrome implementations
// (darwin.ts / win32.ts).
import type { BrowserWindow } from "electron";

export interface PlatformChrome {
  // BrowserWindow constructor options that shape the native chrome
  // (title bar, backdrop, window controls).
  windowOptions(): Electron.BrowserWindowConstructorOptions;
  // Keep native chrome in sync with theme changes for the window the
  // getter returns. No-op where the OS re-tints on its own.
  attachThemeSync(getWindow: () => BrowserWindow | null): void;
}
