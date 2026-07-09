// macOS chrome: inset traffic lights over a transparent shell so the
// NSVisualEffectView material set via `vibrancy` shows through where the
// renderer paints no background (the sidebar column).
import type { PlatformChrome } from "./types";

function windowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "active",
  };
}

// AppKit re-tints the vibrancy material on nativeTheme changes on its
// own; nothing to wire up.
function attachThemeSync(): void {}

export const darwinChrome: PlatformChrome = { windowOptions, attachThemeSync };
