// The shell's hold on its host: the facts it hands over, the calls the
// host makes back (host/process/shell.ts), and the session the shell
// talks to it through (host/process/session.ts).
import { app } from "electron";
import { rendererSchemeOrigin } from "@shared/packaging/rendererScheme.mts";
import type { HostFacts } from "@host/process/facts";
import {
  type HostSession,
  hostSession,
  startHost,
} from "@host/process/session";
import type { ShellCalls } from "@host/process/shell";
import { appPlace } from "./electron/appPlace";
import { relaunchAppUnattended } from "./electron/relaunch";
import { updaterCalls } from "./electron/updater";
import { stopUpdaterBridge } from "./electron/updaterBridge";

function hostFacts(): HostFacts {
  return {
    ...appPlace(),
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    rendererOrigin: rendererSchemeOrigin(app.isPackaged ? "prod" : "dev"),
  };
}

const shellCalls: ShellCalls = {
  relaunch: async () => relaunchAppUnattended(),
  updater: updaterCalls,
  stopUpdaterBridge: async () => stopUpdaterBridge(),
};

let session: HostSession | null = null;

// Wires the host up, ahead of its layer graph.
export function startHostProcess(): void {
  startHost(hostFacts(), shellCalls);
  session = hostSession;
}

export function host(): HostSession {
  if (session === null) throw new Error("the host has not started");
  return session;
}
