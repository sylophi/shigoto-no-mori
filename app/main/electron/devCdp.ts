// Automation hook: SHIGOMORI_DEBUG_PORT=<port> opens
// Chromium's remote-debugging (CDP) endpoint so tooling can drive the
// renderer (screenshots, theme checks, exercising flows end-to-end).
// `electron-forge start -- --remote-debugging-port=...` can't do this:
// forge puts app args after Electron's `--` separator, where Chromium
// stops parsing switches. Env vars survive app.relaunch(), so
// a driven session keeps its port across restarts (e.g. the moveDataDir
// relaunch). A packaged build takes it only as a test flavor
// (flavor.ts debuggable), which the lab drives the same way.
import { app } from "electron";
import { envSetting } from "@shared/config";
import { names } from "../flavor";

let opened: string | undefined;

export function enableDevCdpPort(): void {
  const port = envSetting("SHIGOMORI_DEBUG_PORT");
  if ((!app.isPackaged || names.debuggable) && port) {
    app.commandLine.appendSwitch("remote-debugging-port", port);
    opened = port;
  }
}

// The port opened, for the installer to hand the app it brings back:
// the environment rebuild at launch drops the variable.
export const debugPortOpened = (): string | undefined => opened;
