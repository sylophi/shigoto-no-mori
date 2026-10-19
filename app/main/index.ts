import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { app, dialog, session } from "electron";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { platform } from "node:os";
import path from "node:path";
import { devProfileUserData } from "@shared/packaging/appName.mts";
import { flavor, names } from "./flavor";
import {
  createDesktopClerkBridge,
  serveRendererOverScheme,
} from "./electron/clerk";
import { deepLinkRoute, deepLinkRouteInArgv } from "./electron/deepLink";
import { clerkPublishableKey } from "./ipc/modules/account";
import { setNotificationOpener } from "./electron/notifications";
import { resetSafeStorageItemOnce } from "./electron/keychain";
import { unmountedVolume } from "@shared/unmountedVolume";
import { finishPendingNuke, NUKE_MARKER } from "./core/nuke/finish";
import {
  finishHeadlessNuke,
  headless as headlessNuke,
  runHeadlessNuke,
} from "./electron/headlessNuke";
import { NUKE_EXIT } from "@shigomori/engine/footprint";
import { asksForRemoteDebugging } from "./electron/debugSwitches";
import { enableDevCdpPort } from "./electron/devCdp";
import { captureConsoleToFile } from "./electron/logFile";
import { devProfileSuffix, initDevProfile } from "./electron/devProfile";
import { registerShellHandlers } from "./ipc/handlers";
import { buildAppMenu, installMenuImpl } from "./electron/menu";
import { type HostFailure, hostBusy } from "./hostProcess";
import { installShellPorts } from "./ipc/register";
import {
  dataDir,
  dataDirPointerRead,
  dataDirSource,
  initDataDir,
} from "@shared/paths";
import { applyUserShellEnv } from "@shared/shellEnv";
import { hostFailureWords } from "./hostFailureWords";
import * as Observability from "@shared/observability";
import * as UpdaterEngine from "./electron/updaterEngine";
import { writeTraceLine } from "./electron/logFile";
import * as ClerkTokenStorage from "./electron/clerkTokenStorage";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { childDefaults } from "@shigomori/engine/processes";
import { log } from "@shared/log";
import * as ShellLayer from "./shellLayer";
import * as ClientConfig from "./electron/clientConfig";
import { confirmBusyAction } from "./electron/busyPrompt";
import { isQuittingAfterFailedMove } from "./electron/moveFailed";
import { isRelaunching, relaunchApp } from "./electron/relaunch";
import { LAB_FLAG } from "./argFlags";
import {
  rememberVisibilityAtShutdown,
  rememberVisibilityForRestart,
  takeRestartVisibility,
} from "./electron/restartVisibility";
import {
  openDeepLink,
  openWindowsAtStart,
  rememberWindows,
  reopenIfNone,
  surfaceWindow,
} from "./electron/windows";
import {
  installChildProcessLogging,
  installFatalRecovery,
  reconcileLaunchAtLogin,
  tryFatalRelaunch,
} from "./electron/liveness";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { isInstallingUpdate } from "./electron/updater";
import { takeUpdateEndpointOverrides } from "./electron/updateEndpoints";

if (
  app.isPackaged &&
  !names.debuggable &&
  asksForRemoteDebugging((name) => app.commandLine.hasSwitch(name))
) {
  process.exit(1);
}
enableDevCdpPort();

// The dev profile this instance runs as (electron/devProfile.ts), or
// null. A refused profile is told why (showErrorBox is safe pre-ready)
// and reads as no profile while the exit lands.
function devProfile(): string | null {
  try {
    return initDevProfile();
  } catch (error) {
    dialog.showErrorBox("Shigoto no Mori dev profile", errorMessageOf(error));
    app.exit(1);
    return null;
  }
}

// Each flavor has its own userData and name (main/flavor.ts), so its
// own single-instance lock, Clerk tokens, hub credential, log folder
// and "<name> Safe Storage" keychain item: a v3 build runs beside the
// installed prod one and a dev run beside both, none locking out or
// signing out another.
{
  const profile = devProfile();
  const userData = path.join(app.getPath("appData"), names.userDataDir);
  // A dev profile (shared/packaging/appName.mts) is a further dev
  // instance on this machine with its own userData, so its own lock,
  // credential, grants and tokens: a separate device for testing remote
  // flows against a real peer (scripts/dev-peer.mts).
  app.setPath(
    "userData",
    profile === null ? userData : devProfileUserData(userData, profile),
  );
  app.setName(`${names.appName}${devProfileSuffix()}`);
}

// The dev launcher's Electron-resolution override must never leak into
// processes the host spawns (launchers, script runs, the CLI): any
// other Electron project started from here would silently boot our
// binary instead of its own.
delete process.env.ELECTRON_OVERRIDE_DIST_PATH;
// An agent session's id, when an agent started the app (a dev run):
// nothing the app spawns is that session, and an `sm` it runs would
// bind the session wherever it runs (the engine's Agents).
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CODEX_THREAD_ID;
takeUpdateEndpointOverrides();

// One live instance per data dir. A second copy (typically a fresh
// download in ~/Downloads beside the installed app) would run its own
// host, background fetcher, updater and script registry over
// the same files. `app.exit` skips before-quit, so the losing process
// never reaches the quit sequence at the bottom of this file: it can't
// prompt about busy work, and it can't reap scripts that belong to the
// instance owning the data dir. It tells the user nothing, because raising
// the running window is what launching the app asked for.
if (!app.requestSingleInstanceLock()) {
  app.exit(headlessNuke ? NUKE_EXIT.running : 0);
} else {
  // A nuke's files (main/electron/nuke.ts), before anything opens one:
  // with the lock held, so no other instance is using them.
  const nuked = finishPendingNuke(app.getPath("userData"));
  if (nuked !== null && headlessNuke) {
    finishHeadlessNuke(nuked.left);
  } else if (nuked !== null && nuked.left.length > 0) {
    // Run on, it would delete what it makes at the next start, which
    // finishes the nuke.
    dialog.showErrorBox(
      `${names.appName} couldn't finish erasing itself`,
      `${nuked.left.map((stayed) => `${stayed.path}: ${stayed.why}`).join("\n")}\n\nDelete what's named here, then open the app again. To open it without finishing, delete ${path.join(app.getPath("userData"), NUKE_MARKER)}.`,
    );
    app.exit(1);
  }
}

// After the rename above, which names the log folder, and the nuke's
// deletion of it.
captureConsoleToFile();

// A packaged launch starts from its launcher's environment, Finder's
// stripped one or a terminal's (or an agent's) whole one: rebuild it
// from the login shell, see shared/shellEnv.ts. Started here, after the
// lock (a losing second instance must not run the user's startup
// files for nothing) and before Chromium's own startup, which the
// shell then runs alongside. Awaited in the ready handler, before
// anything spawns on the user's behalf. A dev
// launch starts from the developer's terminal and keeps it. macOS
// only: the base it rebuilds from is launchd's.
const shellEnvReady =
  app.isPackaged && platform() === "darwin"
    ? applyUserShellEnv()
    : Promise.resolve();

// The macOS keychain policy. Only a Developer-ID-signed packaged
// build gets the real keychain, after making sure the Safe Storage
// item is its own. Every other flavor (the ad-hoc per-worktree dev
// bundle, a local `pnpm package` with no identity) runs on Chromium's
// mock keychain, where safeStorage still reports encryption available
// under a constant key: tokens obfuscated, not protected, the
// accepted trade for a build that only runs on the owner's machine.
// main/core/keychain/reset.ts has the model behind the split. After the
// lock: a losing second instance must not delete the running app's
// key on its way out. Before the Clerk bridge and the IPC handlers,
// the two paths to safeStorage.
if (platform() === "darwin") {
  if (app.isPackaged && __SM_SIGNED_MAC_BUILD__) {
    resetSafeStorageItemOnce();
  } else {
    app.commandLine.appendSwitch("use-mock-keychain");
  }
}

// The Clerk main-process bridge: renderer-scheme privileges (pre-ready
// requirement), token storage, and the OAuth deep-link transport. After
// the lock above (the bridge's own lock management is disabled) and the
// dev userData suffix (tokens live in userData). Its cleanup() is
// deliberately not wired to a quit event: every quit path in this file
// ends in app.exit(), which skips will-quit, and process teardown
// reclaims the bridge's IPC handlers wholesale anyway.
createDesktopClerkBridge();

// Every handler is registered before the window can call one: the
// host's as it starts, the shell's after.
installMenuImpl();
registerShellHandlers();
installShellPorts();

// The shell's layer graph, built in the ready handler and closed by the
// quit below, the host's process first.
const runtime = ManagedRuntime.make(
  ShellLayer.layer({ failed: showHostFailure, hurried: isHurriedQuit }).pipe(
    // The renderer asks for its Clerk session as soon as it loads.
    Layer.provideMerge(ClerkTokenStorage.layer(app.getPath("userData"))),
    Layer.provideMerge(UpdaterEngine.layer(flavor)),
    Layer.provideMerge(
      Observability.layer({ packaged: app.isPackaged, writeTraceLine }),
    ),
    // The client config, read before the first window (below).
    Layer.provideMerge(ClientConfig.layer),
    Layer.provideMerge(childDefaults),
    Layer.provideMerge(NodeServices.layer),
  ),
);

// The data dir for the boot error, which may be that it couldn't be
// found at all.
function dataDirOrNone(): string {
  try {
    return dataDir();
  } catch {
    return "The data folder";
  }
}

// The layer graph's build, started in the ready handler.
let graph: Promise<unknown> = Promise.resolve();

// An update install or a relaunch: a quit that neither asks about busy
// work nor waits for it (host/process/layer.ts has why), counted from
// the moment it is asked for, before its quit arrives.
function isHurriedQuit(): boolean {
  return isInstallingUpdate() || isRelaunching() || isQuittingAfterFailedMove();
}

// True while the app is on any teardown or restart path, so the crash
// handlers never fight a quit.
function isShuttingDown(): boolean {
  return quitting || isHurriedQuit();
}

// A notification's click opens its page the way a deep link does.
setNotificationOpener(openDeepLink);

// Windows and Linux pass a deep link in a launch's argv: this
// process's own when the link started the app, the second instance's
// otherwise. macOS sends open-url, registered here before "ready" so a
// link that launched the app is not missed.
const launchRoute = deepLinkRouteInArgv(process.argv);
if (launchRoute) openDeepLink(launchRoute);

// Launching the app again while a copy runs is a request to see it, and
// so is a deep link.
app.on("second-instance", (_event, argv) => {
  const route = deepLinkRouteInArgv(argv);
  if (route) openDeepLink(route);
  else surfaceWindow();
});

app.on("open-url", (event, url) => {
  const route = deepLinkRoute(url);
  if (route === null) return;
  event.preventDefault();
  openDeepLink(route);
});

// Started for the lab (argFlags.ts LAB_FLAG): SIGUSR2 relaunches the
// app as a window's own relaunch does. lab/relaunch.mts sends it, since
// a packaged build takes no debugger to ask its window with
// (electron/debugSwitches.ts).
if (process.argv.includes(LAB_FLAG)) {
  process.on("SIGUSR2", () => relaunchApp());
}

app.on("ready", async () => {
  // Electron grants most permission requests by default, and this
  // window hosts remote content (Clerk's script and captcha iframe), so
  // everything is refused except what the app uses: copy buttons, which
  // Electron routes through here as clipboard-sanitized-write.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"),
  );
  // The scheme the windows load from (electron/windows.ts). protocol.handle
  // only works post-ready, and it must precede the first loadURL.
  serveRendererOverScheme(
    MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? { devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL }
      : {
          rendererDir: path.join(
            __dirname,
            `../renderer/${MAIN_WINDOW_VITE_NAME}`,
          ),
        },
    clerkPublishableKey(),
  );
  // The rebuilt environment (module top), before the first spawn.
  await shellEnvReady;
  // The data folder, which the updater reads and the host is forked
  // onto. The host comes up while the window loads.
  try {
    await initDataDir(flavor);
    // A pointer to a folder on a volume that isn't there (an external
    // drive unplugged) finds nothing to stand on: said here, rather than
    // as a host that couldn't start.
    const volume =
      dataDirSource() === "pointer" ? unmountedVolume(dataDir()) : null;
    if (volume !== null) {
      throw new Error(`${volume} isn't connected.`);
    }
  } catch (err) {
    // A pointer file can aim the data dir somewhere that isn't reachable
    // right now (external drive unplugged, permissions changed). A
    // silent unhandled rejection here would leave the app running with
    // no window. Say what's wrong and how to recover instead. The data
    // dir itself may be what failed to resolve, the pointer with it.
    let pointer: string | null = null;
    try {
      pointer = dataDirPointerRead();
    } catch {
      pointer = null;
    }
    const recovery =
      pointer !== null
        ? "If you moved the data folder to an external drive, reconnect " +
          "it and relaunch. To fall back to the default location, delete " +
          `the pointer file at ${pointer}.`
        : "Check the folder's permissions, or move it aside to start fresh.";
    dialog.showErrorBox(
      "Shigoto no Mori can't access its data folder",
      `${dataDirOrNone()} could not be created or accessed.\n\n${recovery}\n\n` +
        `${errorMessageOf(err)}`,
    );
    app.exit(1);
    return;
  }
  graph = runtime.context();
  buildAppMenu();
  // Host liveness. Install the crash guards before
  // the window exists so an early fatal error is still caught, then
  // reconcile the login item to the saved keepReachable opt-in. The same
  // reconcile reruns after every clientConfig patch (the patch handler)
  // and every sign-in or sign-out (the account fan-out in
  // ipc/handlers.ts), making this the boot-time pass only.
  installChildProcessLogging();
  installFatalRecovery({ isShuttingDown, rememberWindows });
  // The saved theme before the first window. A graph that
  // failed first has no config to wait for, and its defaults stand.
  await Promise.race([
    ClientConfig.clientConfigRead(),
    graph.then(
      () => undefined,
      () => undefined,
    ),
  ]);
  // `<binary> nuke`: the halves a window would run, and no window.
  if (headlessNuke) {
    await graph.catch(() => undefined);
    await runHeadlessNuke();
    return;
  }
  openWindowsAtStart({ restart: takeRestartVisibility(), isShuttingDown });
  reconcileLaunchAtLogin();
  rememberVisibilityAtShutdown();
  // The window is already up, so the graph delays only the background
  // machinery. A quit that came first has disposed it.
  await graph.catch((error: unknown) => {
    if (!quitting) log.error("[boot] the layer graph failed:", error);
  });
});

// The app is its windows: closing the last one quits, on macOS too.
app.on("window-all-closed", () => {
  app.quit();
});

// A host that could not start: the store it could not open, with what
// the engine's doctor found, or why it kept stopping.
function showHostFailure(failure: HostFailure): void {
  // The log has it too: the dialog below holds the process until it is
  // dismissed, and nothing else says why.
  log.error(
    "[host] could not start:",
    failure.store?.report ?? failure.message,
  );
  // A host that kept stopping, on a machine kept reachable for other
  // devices: relaunched within the fatal-relaunch budget rather than
  // left on a dialog nobody may be there to dismiss. A store that won't
  // open is no better for a relaunch, and says so.
  if (
    failure.store === null &&
    !isShuttingDown() &&
    tryFatalRelaunch(rememberWindows)
  ) {
    app.exit(1);
    return;
  }
  const { title, body } = hostFailureWords(failure, flavor);
  dialog.showErrorBox(title, body);
  process.exit(1);
}

// Every quit path lands here: the graph's shutdown runs its finalizers
// (shellLayer.ts), then `app.exit` ends the process without coming back
// through before-quit. A second quit while the graph closes is let
// through as Electron's own, the way out of a finalizer that hangs.
let quitting = false;

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  // An update install was already confirmed by the renderer's
  // installUpdate dialog, and a relaunch's cancelled quit would leave a
  // live app on a data dir that has moved. Ahead of a busy prompt
  // already open, whose cancel must not keep such an app running.
  if (isHurriedQuit()) {
    quit();
    return;
  }
  if (askingToQuit) return;
  askingToQuit = true;
  void Effect.runPromise(hostBusy(true))
    .then((busy) => confirmBusyAction("quit", busy))
    .catch((error: unknown) => {
      // A host that cannot answer has nothing to lose to the quit.
      log.warn(`[quit] the host's busy check failed: ${errorMessageOf(error)}`);
      return true;
    })
    .then((proceed) => {
      askingToQuit = false;
      // A hurried quit taken while this prompt was open is underway.
      if (quitting) return;
      if (proceed) {
        quit();
        return;
      }
      // When the user got here by closing the last window (close-X →
      // window-all-closed → app.quit()), it is already gone. Reopen it
      // so the cancelled quit doesn't leave the app running headless
      // with the busy work still in progress. Cmd-Q / menu Quit reach
      // before-quit before any window is closed, so this is a no-op
      // there.
      reopenIfNone();
    });
});

// While the busy prompt is up, a second quit waits for its answer.
let askingToQuit = false;

// Past the host's own quit deadline (15 s), so a host that is slow to
// close is still killed by its hold first.
const QUIT_CLOSE_DEADLINE = "20 seconds";

function quit(): void {
  quitting = true;
  const hurried = isHurriedQuit();
  rememberWindows();
  if (hurried) rememberVisibilityForRestart();
  // The host is given its own deadline to close (hostProcess.ts); the
  // rest of the graph closes beside it, and a finalizer that hangs past
  // both does not keep the app, or a logout, waiting.
  // The close runs on a fiber of its own, since a scope closes
  // uninterruptibly: only the wait for it is bounded.
  void Effect.runPromise(
    Effect.forkDetach(runtime.disposeEffect).pipe(
      Effect.flatMap((closing) =>
        Fiber.join(closing).pipe(
          Effect.timeoutOrElse({
            duration: QUIT_CLOSE_DEADLINE,
            orElse: () =>
              Effect.sync(() =>
                log.error("[quit] the graph did not close in time, exiting"),
              ),
          }),
        ),
      ),
    ),
  )
    .catch((error: unknown) => {
      log.error("[quit] a finalizer failed:", error);
    })
    .finally(() => app.exit(0));
}
