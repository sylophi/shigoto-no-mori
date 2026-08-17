// macOS chrome: inset traffic lights over a transparent shell so the
// NSVisualEffectView material set via `vibrancy` shows through where the
// renderer paints no background (the sidebar column).
export function chromeWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "active",
  };
}
