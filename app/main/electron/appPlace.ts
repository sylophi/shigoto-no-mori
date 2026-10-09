// The shell's app place (shared/packaging/bundledBinary.mts), and the
// facts the host is handed at start beside it (host/process/facts.ts).
import { app } from "electron";
import type { AppPlace } from "@shared/packaging/bundledBinary.mts";

export function appPlace(): AppPlace {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  };
}
