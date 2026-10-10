import { app, dialog, session } from "electron";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { platform } from "node:os";
import path from "node:path";
import {
  DEV_NAME_SUFFIX,
  DEV_USER_DATA_SUFFIX,
  devProfileUserData,
} from "@shared/packaging/appName.mts";
import {
  createDesktopClerkBridge,
  serveRendererOverScheme,
} from "./electron/clerk";
import { deepLinkRoute, deepLinkRouteInArgv } from "./electron/deepLink";
import { setNotificationOpener } from "./electron/notifications";
import { resetSafeStorageItemOnce } from "./electron/keychain";
import { enableDevCdpPort } from "./electron/devCdp";
import { captureConsoleToFile } from "./electron/logFile";
import { devProfileSuffix, initDevProfile } from "./electron/devProfile";
import { registerShellHandlers } from "./ipc/handlers";
import { buildAppMenu, installMenuImpl } from "./electron/menu";
import {
  type HostFailure,
  host,
  startHostProcess,
  stopHostProcess,
} from "./hostProcess";
import { installShellPorts } from "./ipc/register";
import { dataDir, dataDirPointerRead, initDataDir } from "@host/lib/util/paths";
import { applyUserShellEnv } from "@host/lib/util/shellEnv";
import { cliBinaryName } from "@shared/packaging/cliDist.mts";
import * as Observability from "@host/lib/util/observability";
import * as UpdaterEngine from "./electron/updaterEngine";
import { writeTraceLine } from "./electron/logFile";
import * as ClerkTokenStorage from "./electron/clerkTokenStorage";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { log } from "@shared/log";
import * as ShellLayer from "./shellLayer";
import { confirmBusyAction } from "./electron/busyPrompt";
import { isRelaunching } from "./electron/relaunch";
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
} from "./electron/liveness";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { isInstallingUpdate } from "./electron/updater";
import { takeUpdateEndpointOverrides } from "./electron/updateEndpoints";

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

// Electron scopes the single-instance lock to the userData directory,
// and dev and packaged builds resolve the same one out of productName.
// A dev run owns a different data dir (~/.smd), so give it
// its own userData or an installed copy would lock it out.
if (!app.isPackaged) {
  const profile = devProfile();
  const devUserData = `${app.getPath("userData")}${DEV_USER_DATA_SUFFIX}`;
  // A dev profile (shared/packaging/appName.mts) is a further dev
  // instance on this machine with its own userData, so its own lock,
  // credential, grants and tokens: a separate device for testing remote
  // flows against a real peer (scripts/dev-peer.mts).
  app.setPath(
    "userData",
    profile === null ? devUserData : devProfileUserData(devUserData, profile),
  );
  // The rename gives dev its own menu bar label and, on Linux and
  // Windows where safeStorage really talks to libsecret/DPAPI, its
  // own "<name> Safe Storage" item so dev tokens never share prod's
  // encryption key. (On macOS dev never reaches the keychain, see
  // below.) After the userData suffix above, so the dev data path
  // stays derived from the shared productName.
  app.setName(`${app.name}${DEV_NAME_SUFFIX}${devProfileSuffix()}`);
}

// After the rename above, which names the log folder.
captureConsoleToFile();

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
// state watcher, background fetcher, updater and script registry over
// the same files. `app.exit` skips before-quit, so the losing process
// never reaches the quit sequence at the bottom of this file: it can't
// prompt about busy work, and it can't reap scripts that belong to the
// instance owning the data dir. It tells the user nothing, because raising
// the running window is what launching the app asked for.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// A packaged launch starts from its launcher's environment, Finder's
// stripped one or a terminal's (or an agent's) whole one: rebuild it
// from the login shell, see core/shellEnv.ts. Started here, after the
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

// The build flavor, which names the data dir and the terminal `sm`.
const flavor = app.isPackaged ? ("prod" as const) : ("dev" as const);

// The shell's layer graph, built in the ready handler and closed by the
// quit below, after the host's process has gone.
const runtime = ManagedRuntime.make(
  ShellLayer.layer.pipe(
    // The renderer asks for its Clerk session as soon as it loads.
    Layer.provideMerge(ClerkTokenStorage.layer(app.getPath("userData"))),
    Layer.provideMerge(UpdaterEngine.layer(flavor)),
    Layer.provideMerge(
      Observability.layer({ packaged: app.isPackaged, writeTraceLine }),
    ),
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
// work nor waits for it (hostLayer.ts has why), counted from the moment
// it is asked for, before its quit arrives.
function isHurriedQuit(): boolean {
  return isInstallingUpdate() || isRelaunching();
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
  );
  // The rebuilt environment (module top), before the first spawn.
  await shellEnvReady;
  // The data folder, which the updater reads and the host is forked
  // onto. The host comes up while the window loads.
  try {
    await initDataDir(flavor);
  } catch (err) {
    // A pointer file can aim the data dir somewhere that isn't reachable
    // right now (external drive unplugged, permissions changed). A
    // silent unhandled rejection here would leave the app running with
    // no window. Say what's wrong and how to recover instead.
    const pointer = dataDirPointerRead();
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
  startHostProcess({ failed: showHostFailure });
  graph = runtime.context();
  buildAppMenu();
  // Host liveness. Install the crash guards before
  // the window exists so an early fatal error is still caught, then
  // reconcile the login item to the saved keepReachable opt-in. The same
  // reconcile reruns after every clientConfig write (the write handler)
  // and every sign-in or sign-out (the account fan-out in
  // ipc/handlers.ts), making this the boot-time pass only.
  installChildProcessLogging();
  installFatalRecovery({ isShuttingDown, rememberWindows });
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
  if (failure.storeReport !== null) {
    dialog.showErrorBox(
      "Shigoto no Mori can't open its data",
      `${failure.storeReport}\n\nRun \`${cliBinaryName(flavor)} doctor\` in a terminal for the repairs it offers.`,
    );
  } else {
    dialog.showErrorBox(
      "Shigoto no Mori can't start",
      `${failure.message}\n\nQuit and relaunch the app. If it keeps happening, restart your machine or reinstall.`,
    );
  }
  app.exit(1);
}

// Every quit path lands here: the graph's shutdown runs its finalizers
// (hostLayer.ts), then `app.exit` ends the process without coming back
// through before-quit. A second quit while the graph closes is let
// through as Electron's own, the way out of a finalizer that hangs.
let quitting = false;

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  if (askingToQuit) return;
  // An update install was already confirmed by the renderer's
  // installUpdate dialog, and a relaunch's cancelled quit would leave a
  // live app on a data dir that has moved.
  if (isHurriedQuit()) {
    quit();
    return;
  }
  askingToQuit = true;
  void host()
    .busy()
    .then((busy) => confirmBusyAction("quit", busy))
    .catch((error: unknown) => {
      // A host that cannot answer has nothing to lose to the quit.
      log.warn(`[quit] the host's busy check failed: ${errorMessageOf(error)}`);
      return true;
    })
    .then((proceed) => {
      askingToQuit = false;
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

function quit(): void {
  quitting = true;
  const hurried = isHurriedQuit();
  rememberWindows();
  if (hurried) rememberVisibilityForRestart();
  // The host first, whose quit sequence (host/process/layer.ts) may
  // still ask the shell for its updater bridge.
  void stopHostProcess(hurried)
    .then(() => runtime.dispose())
    .catch((error: unknown) => {
      log.error("[quit] a finalizer failed:", error);
    })
    .finally(() => app.exit(0));
}
