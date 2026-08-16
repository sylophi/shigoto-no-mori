// Dev-only automation hook: SHIGOMORI_DEBUG_PORT=<port> opens
// Chromium's remote-debugging (CDP) endpoint so tooling can drive the
// renderer (screenshots, theme checks, exercising flows end-to-end).
// `electron-forge start -- --remote-debugging-port=...` can't do this
// -- forge puts app args after Electron's `--` separator, where
// Chromium stops parsing switches. Env vars survive app.relaunch(), so
// a driven session keeps its port across restarts (e.g. the moveRoot
// relaunch). No-op in packaged builds.
import { app } from "electron";

export function enableDevCdpPort(): void {
  const port = process.env.SHIGOMORI_DEBUG_PORT;
  if (!app.isPackaged && port) {
    app.commandLine.appendSwitch("remote-debugging-port", port);
  }
}
