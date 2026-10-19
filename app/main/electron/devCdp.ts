// Automation hook: SHIGOMORI_DEBUG_PORT=<port> opens
// Chromium's remote-debugging (CDP) endpoint so tooling can drive the
// renderer (screenshots, theme checks, exercising flows end-to-end).
// `electron-forge start -- --remote-debugging-port=...` can't do this:
// forge puts app args after Electron's `--` separator, where Chromium
// stops parsing switches. A relaunch passes the port on
// (engine/relaunchEnv.ts), so a driven session keeps it across
// restarts. A packaged build takes it only as a test flavor (flavor.ts
// debuggable), which the lab drives the same way.
import { app } from "electron";
import { RELAUNCH_ENV } from "@shigomori/engine/relaunchEnv";
import { envSetting } from "@shared/config";
import { names } from "../flavor";

let opened: string | undefined;

export function enableDevCdpPort(): void {
  const port = envSetting(RELAUNCH_ENV.debugPort);
  if ((!app.isPackaged || names.debuggable) && port) {
    app.commandLine.appendSwitch("remote-debugging-port", port);
    opened = port;
  }
}

// The port opened, for a relaunch to hand the app it brings back: the
// environment rebuild at launch drops the variable.
export const debugPortOpened = (): string | undefined => opened;
