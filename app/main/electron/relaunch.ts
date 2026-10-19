// Programmatic app restart (the data-folder move, a nuke): renderer-initiated
// after its moveDataDir invoke resolves, so the reply is guaranteed
// delivered before the window goes away, with no timing guesses. A move
// asked for by another device has no renderer here to acknowledge it,
// so that one restarts a beat after answering (relaunchAppUnattended).
// The flag makes the quit a hurried one, as an update install's is
// (main/index.ts): scripts were already reaped by the move, so there is
// nothing to prompt about, and a busy dialog here could be cancelled,
// leaving a live app pointed at a data dir that no longer exists.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { app } from "electron";
import { DEV_RELAUNCH_FILE_ENV } from "@shared/packaging/appName.mts";
import { openEnvArgs } from "@shigomori/engine/relaunchEnv";
import { dataDir, dataDirSource } from "@shared/paths";
import { debugPortOpened } from "./devCdp";
import { updateEndpoints } from "./updateEndpoints";
import { log } from "@shared/log";
import { envSetting } from "@shared/config";

let requested = false;

// Under `pnpm dev` a relaunch cannot be app.relaunch(): forge exits
// with Electron and takes the vite server with it, and the detached
// copy would open on a dead renderer. The dev launcher
// (scripts/dev-electron.mts) hands over a marker path instead, and
// restarts forge when the app quits with the marker present.
const devRelaunchMarker = envSetting(DEV_RELAUNCH_FILE_ENV);

// Record that a relaunch is in flight WITHOUT initiating the quit. The
// data-folder move (relaunchApp) quits through Electron so its reply is
// delivered first. The fatal-recovery path in liveness.ts instead exits
// hard, but it still sets this flag so a quit that does start is a
// hurried one, with no busy-action prompt.
function markRelaunching(): void {
  requested = true;
}

// The packaged app starts again through LaunchServices, as `sm update`
// brings it back after an install: a detached waiter opens the bundle
// once this process has exited. Not app.relaunch(): its relauncher
// starts the new instance as a child of this app, which macOS then
// counts among this app's subordinate processes, and when a foreground
// app quits, loginwindow terminates its subordinates (unless
// Background Task Management says it may run in the background) a
// second or so later. Every child of the new instance (its window's
// renderer, the GPU, the host) was killed with them, which left a dead
// window after the migration's restart, a data-folder move or a nuke.
function relaunchThroughLaunchServices(): void {
  // <bundle>/Contents/MacOS/<executable>
  const bundle = dirname(dirname(dirname(app.getPath("exe"))));
  const args = process.argv.slice(1);
  const open = [
    "-n",
    ...openEnvArgs({
      ...updateEndpoints(),
      dataDir: dataDirSource() === "env" ? dataDir() : undefined,
      debugPort: debugPortOpened(),
    }),
    "-a",
    bundle,
    ...(args.length > 0 ? ["--args", ...args] : []),
  ];
  spawn(
    "/bin/sh",
    [
      "-c",
      'while kill -0 "$0" 2>/dev/null; do sleep 0.05; done; exec /usr/bin/open "$@"',
      String(process.pid),
      ...open,
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
}

// Arrange for the app to start again once this process is gone, by
// whichever mechanism this run has. Does not quit: the data-folder
// move quits through Electron (relaunchApp), the fatal-recovery path
// in liveness.ts exits hard on its own.
export function scheduleRelaunch(): void {
  // One waiter: a second would open a second instance.
  if (requested) return;
  markRelaunching();
  if (devRelaunchMarker !== undefined) {
    try {
      writeFileSync(devRelaunchMarker, "");
      return;
    } catch (error) {
      // A marker that cannot be written must not strand the app on a
      // data dir that has already moved: the plain relaunch is the
      // one that loses the vite server, not the one that loses data.
      log.warn(`[relaunch] could not write the dev marker: ${error}`);
    }
  }
  relaunchThroughLaunchServices();
}

export function relaunchApp(): void {
  scheduleRelaunch();
  app.quit();
}

// How long a quit asked for over a link waits after its handler
// resolved. The invoke is answered when the handler resolves, and quit
// tears the listener down (a peer's direct one, a window's loopback)
// before a queued frame can leave, so the quit trails the reply and the
// caller sees success instead of a dropped session. Shared with the
// updater's install.
export const QUIT_AFTER_ANSWER_MS = 500;

// The relaunch is arranged at once and only the quit waits: a quit
// from this machine's own user inside the gap then still comes back
// up, as the peer was told it would, and is a hurried quit.
export function relaunchAppUnattended(): void {
  if (requested) return;
  scheduleRelaunch();
  setTimeout(() => app.quit(), QUIT_AFTER_ANSWER_MS);
}

export function isRelaunching(): boolean {
  return requested;
}
