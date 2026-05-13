import { app, ipcMain } from "electron";
import { homedir } from "node:os";
import { CHANNELS, type RuntimeInfo } from "@shared/channels";
import { shigomoriRoot } from "../paths";

function tildify(absolute: string): string {
  const home = homedir();
  return absolute.startsWith(home)
    ? `~${absolute.slice(home.length)}`
    : absolute;
}

export function registerRuntimeHandlers(): void {
  ipcMain.handle(
    CHANNELS.RuntimeInfo,
    (): RuntimeInfo => ({
      shigomoriRoot: tildify(shigomoriRoot()),
      homedir: homedir(),
      isDev: !app.isPackaged,
    }),
  );
}
