// The app's updater (shared/updater/machine.ts) in the Electron shell:
// the version and the bundled `sm` are the app's, the host is asked
// over its port, a busy restart is the person's to confirm, and the
// install is the detached installer the app quits for.
import { spawn } from "node:child_process";
import { app } from "electron";
import * as Effect from "effect/Effect";
import { RELAUNCH_ENV } from "@shigomori/engine/relaunchEnv";
import { makeUpdater } from "@shared/updater/machine";
import { hostBusy, isQuitting, noteUpdaterState } from "../hostProcess";
import { flavor } from "../flavor";
import { confirmBusyAction } from "./busyPrompt";
import { requireCliBinary } from "./cliBinary";
import { debugPortOpened } from "./devCdp";
import { updateEndpoints } from "@shared/updater/endpoints";

// The installer, `sm update --finish-install`, which waits for this
// process to exit, swaps the bundle and opens the new one, so it must
// outlive the app: detached and never reaped. Settles only once the
// child actually spawned (or failed to): spawn errors arrive
// asynchronously, and the caller is about to quit on success.
function spawnInstaller(): Promise<void> {
  const binary = requireCliBinary();
  const { feedUrl, releasesUrl } = updateEndpoints();
  const debugPort = debugPortOpened();
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "update",
        "--finish-install",
        "--pid",
        String(process.pid),
        ...(feedUrl ? ["--feed-url", feedUrl] : []),
        ...(releasesUrl ? ["--releases-url", releasesUrl] : []),
      ],
      {
        detached: true,
        stdio: "ignore",
        ...(debugPort === undefined
          ? {}
          : { env: { ...process.env, [RELAUNCH_ENV.debugPort]: debugPort } }),
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const updater = makeUpdater({
  flavor,
  packaged: app.isPackaged,
  version: app.getVersion(),
  cliBinary: requireCliBinary,
  // Called through: hostProcess.ts imports this module back.
  noteState: (state) => noteUpdaterState(state),
  busy: (quitAfter) => Effect.runPromise(hostBusy(quitAfter)),
  confirmRestart: {
    ask: () => confirmBusyAction("restart"),
    isQuitting: () => isQuitting(),
  },
  handOff: Effect.tryPromise(spawnInstaller),
  quit: () => app.quit(),
});

export const {
  layer,
  calls: updaterCalls,
  isInstallingUpdate,
  currentUpdaterState,
  releaseBridge: releaseUpdaterBridge,
} = updater;
