import { app, BrowserWindow, dialog, session } from "electron";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { platform } from "node:os";
import path from "node:path";
import {
  DEV_NAME_SUFFIX,
  DEV_USER_DATA_SUFFIX,
  devProfileUserData,
} from "@shared/packaging/appName.mts";
import { windowContract } from "@shigomori/contracts/modules/window";
import { readDeviceId } from "@host/lib/config/deviceId";
import { loadSharedSettings } from "@host/lib/sharedSettings/store";
import {
  createDesktopClerkBridge,
  rendererSchemeUrl,
  serveRendererOverScheme,
} from "./electron/clerk";
import {
  APP_VERSION_FLAG,
  CLERK_PK_FLAG,
  DEV_BUILD_FLAG,
  DEVICE_ID_FLAG,
} from "./argFlags";
import { attachContextMenu } from "./electron/contextMenu";
import {
  deepLinkRoute,
  deepLinkRouteInArgv,
  receiveDeepLink,
} from "./electron/deepLink";
import { setNotificationOpener } from "./electron/notifications";
import { resetSafeStorageItemOnce } from "./electron/keychain";
import { enableDevCdpPort } from "./electron/devCdp";
import { captureConsoleToFile } from "./electron/logFile";
import { devProfileSuffix, initDevProfile } from "./electron/devProfile";
import { sweepProjects } from "./electron/fetch";
import {
  applyThemeSource,
  readClientConfigSync,
} from "./electron/clientConfig";
import { registerIpcHandlers } from "./ipc/handlers";
import { clerkPublishableKey } from "./ipc/modules/account";
import { installHostImpls } from "./electron/hostImpls";
import { buildAppMenu, installMenuImpl } from "./electron/menu";
import { broadcast } from "./ipc/register";
import { startOrphanScriptSweep } from "@host/lib/scripts/persistence";
import { dataDir, dataDirPointerRead, initDataDir } from "@host/lib/util/paths";
import { applyUserShellEnv } from "./core/shellEnv";
import * as HostLayer from "./hostLayer";
import { bundledBinaryPath } from "./electron/bundledBinary";
import { storeFailureReport } from "./electron/storeFailure";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import {
  MACFS_BINARY_NAME,
  MACFS_DIST_DIR,
} from "@shared/packaging/macfsDist.mts";
import * as Observability from "./observability";
import * as ClerkTokenStorage from "./electron/clerkTokenStorage";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { log } from "@shared/log";
import * as ShellLayer from "./shellLayer";
import { confirmBusyActionSync } from "./electron/busyPrompt";
import { isRelaunching } from "./electron/relaunch";
import {
  applyRestartVisibility,
  rememberVisibilityAtShutdown,
  rememberVisibilityForRestart,
  type RestartVisibility,
  takeRestartVisibility,
} from "./electron/restartVisibility";
import {
  attachRenderProcessRecovery,
  installChildProcessLogging,
  installFatalRecovery,
  reconcileLaunchAtLogin,
} from "./electron/liveness";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { installUpdaterImpl, isInstallingUpdate } from "./electron/updater";
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

// Electron-layer impls must be wired before registerIpcHandlers runs so
// the first renderer call never lands on the throwing default.
installMenuImpl();
installUpdaterImpl();
installHostImpls();
registerIpcHandlers();

// The engine's build flavor and its darwin helper, for the graph and
// for the doctor a store that won't open gets.
const engineOptions = {
  flavor: app.isPackaged ? ("prod" as const) : ("dev" as const),
  macfs: bundledBinaryPath(MACFS_DIST_DIR, MACFS_BINARY_NAME),
  sm: bundledBinaryPath(
    CLI_DIST_DIR,
    cliBinaryName(app.isPackaged ? "prod" : "dev"),
  ),
};

// The process's one layer graph, built in the ready handler once the
// window is up and closed by the quit below. Every subsystem with a
// lifetime is in it, so its shutdown is the quit sequence.
const runtime = ManagedRuntime.make(
  ShellLayer.layer.pipe(
    Layer.provideMerge(
      HostLayer.layer({
        hurried: isHurriedQuit,
        engine: engineOptions,
      }),
    ),
    // The shell's, but below the host: the renderer asks for its Clerk
    // session as soon as it loads.
    Layer.provideMerge(ClerkTokenStorage.layer(app.getPath("userData"))),
    Layer.provideMerge(Observability.layer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

let mainWindow: BrowserWindow | null = null;
// Set once the ready handler's own createWindow() call has run, so
// second-instance can tell "boot is still in flight" (nothing to do
// yet, that call is on its way) apart from "the window was closed
// after boot" (recreate it). Without this, a launch that lands during
// the ready handler's await (ensureDataDir on a slow or
// unreachable data folder) would see mainWindow still null, create a
// window itself, and then get a second one from the ready handler
// finishing right after.
let hasBooted = false;

// Read once in the ready handler (a corrupt registry throws there, into
// the boot error dialog). createWindow only interpolates it. Never
// empty by the time any window exists: getDeviceId mints or throws.
let deviceId = "";

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

const createWindow = (restart: RestartVisibility | null = null) => {
  hasBooted = true;
  // Drive the native appearance from the saved theme before constructing
  // the window so the macOS vibrancy material picks the right light/dark
  // variant on first paint. Absent or "system" delegates back to the OS.
  applyThemeSource(readClientConfigSync().theme);
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 420,
    show: restart === null,
    // Inset traffic lights over a transparent shell so the
    // NSVisualEffectView material set via `vibrancy` shows through where
    // the renderer paints no background (the sidebar column). Inset as
    // far from the top as from the left, which centers the 14pt buttons
    // on y=23: the renderer's title bars line up on that (SidebarHeader,
    // PageHeader's device tabs).
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Synchronous delivery of the device id: the preload reads this
      // flag off process.argv and exposes it on the bridge, so the
      // renderer never has to gate key building behind an IPC call.
      // The id itself is read in the ready handler, whose try/catch
      // turns a corrupt registry into the error dialog instead of a
      // throw out of createWindow with no window.
      // The dev flag rides the same channel: isDev is a fact about this
      // client build, not the host, so it must not travel via
      // runtime.info.
      additionalArguments: [
        `${DEVICE_ID_FLAG}${deviceId}`,
        // This build's version, delivered the same way as the device id
        // and the dev flag: the renderer sends it in the socket hello
        // and compares it against a remote host's welcome for skew.
        `${APP_VERSION_FLAG}${app.getVersion()}`,
        // The resolved Clerk publishable key (empty when the build is
        // unconfigured), so the renderer can mount or skip the
        // ClerkProvider synchronously at boot.
        `${CLERK_PK_FLAG}${clerkPublishableKey()}`,
        ...(app.isPackaged ? [] : [DEV_BUILD_FLAG]),
      ],
    },
  });

  // The renderer is a single local document with in-memory routing, so
  // no in-page navigation or popup is ever legitimate. External links go
  // through the scheme-validated shell:openExternal IPC instead. Same-URL
  // navigation stays allowed so the dev server's full reload still works.
  const webContents = mainWindow.webContents;
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, url) => {
    if (url !== webContents.getURL()) event.preventDefault();
  });

  // Both modes load over the renderer scheme rather than file:// or the
  // vite http origin. Clerk requires it (see main/electron/clerk.ts).
  // The protocol handler is installed in the ready handler below,
  // before the first createWindow.
  void mainWindow.loadURL(rendererSchemeUrl());

  // Relay BrowserWindow focus/blur to the renderer. The web-level `focus`
  // and `visibilitychange` events don't fire on every Electron focus
  // transition (notably ⌘Tab between apps), so React Query's
  // refetch-on-focus needs this signal to be reliable.
  const sendFocus = () => {
    const wc = mainWindow?.webContents;
    if (wc) broadcast(windowContract, "focused", undefined, wc);
    sweepProjects();
  };
  const sendBlur = () => {
    const wc = mainWindow?.webContents;
    if (wc) broadcast(windowContract, "blurred", undefined, wc);
  };
  mainWindow.on("focus", sendFocus);
  mainWindow.on("blur", sendBlur);

  // Recover the UI from a renderer crash. Attached
  // per window, including the ones recreated below, so a second crash
  // still lands on a live handler. The recreate budget lives in the
  // liveness module, so re-attaching does not reset the loop guard.
  attachRenderProcessRecovery(mainWindow, {
    isShuttingDown,
    recreateWindow: recreateAfterRendererCrash,
    onGiveUp: showCrashGiveUpDialog,
  });

  attachContextMenu(mainWindow);
  if (restart) applyRestartVisibility(mainWindow, restart);
};

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

// Recreate the window after its renderer crashed. The crashed shell can
// linger with a dead renderer, so destroy the previous one after the new
// window has taken its place, leaving no ghost behind.
const recreateAfterRendererCrash = () => {
  const previous = mainWindow;
  createWindow();
  if (previous && !previous.isDestroyed()) previous.destroy();
};

// Set when the renderer crash-loop guard gives up: mainWindow then points
// at a shell whose renderer is gone but whose isDestroyed() is still
// false, so second-instance must recreate rather than raise a dead frame.
// Cleared on the next successful recreate.
let gaveUp = false;

// Last resort when the renderer crash-loops: stop recreating and tell the
// user, rather than thrash a window that dies as fast as it opens.
const showCrashGiveUpDialog = () => {
  gaveUp = true;
  dialog.showErrorBox(
    "Shigoto no Mori keeps crashing",
    "The window crashed several times in a row, so it was not reopened " +
      "to avoid a crash loop. Quit and relaunch the app. If it keeps " +
      "happening, restart your machine or reinstall.",
  );
};

// Launching the app again while a copy runs is a request to see it, and
// so is a deep link, so surface the window we already have. It can be
// missing if the user closed it and then cancelled the quit that
// followed. Before the first boot-time createWindow() call, do nothing
// beyond the focus below: that call is already on its way, and racing
// it here would leave two windows open instead of one.
function surfaceMainWindow(): void {
  // After the crash-loop guard gave up, or if the renderer has crashed,
  // mainWindow is a live handle to a dead shell: isDestroyed() is false
  // but its renderer is gone, so show()/focus() would raise an empty
  // frame. Recreate instead (and clear the give-up latch on success).
  const deadShell =
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    (gaveUp || mainWindow.webContents.isCrashed());
  if (mainWindow && !mainWindow.isDestroyed() && !deadShell) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (hasBooted) {
    // recreateAfterRendererCrash destroys the dead shell (if any) after
    // the fresh window takes its place, leaving no ghost behind. When no
    // window exists it is just a createWindow.
    recreateAfterRendererCrash();
    gaveUp = false;
  }
  // macOS won't raise a background app just because one of its windows
  // asked for focus, and the launch the user just made is already gone.
  app.focus({ steal: true });
}

// Hands a deep link's route to the renderer (main/electron/deepLink.ts)
// and raises the window it will open in. Before "ready" (a link that
// launched the app) there is nothing to raise yet: the boot-time window
// is on its way and takes the link.
function openDeepLink(route: string): void {
  if (app.isReady()) surfaceMainWindow();
  const live = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  receiveDeepLink(route, live?.webContents);
}

// A notification's click opens its page the same way.
setNotificationOpener(openDeepLink);

// Windows and Linux pass a deep link in a launch's argv: this
// process's own when the link started the app, the second instance's
// otherwise. macOS sends open-url, registered here before "ready" so a
// link that launched the app is not missed.
const launchRoute = deepLinkRouteInArgv(process.argv);
if (launchRoute) receiveDeepLink(launchRoute, undefined);

app.on("second-instance", (_event, argv) => {
  const route = deepLinkRouteInArgv(argv);
  if (route) openDeepLink(route);
  else surfaceMainWindow();
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
  // The scheme the window loads from (see createWindow). protocol.handle
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
  // The graph starts here: its bottom opens the store, which the
  // window's first paint needs the device id from. The rest comes up
  // behind the window.
  try {
    await initDataDir(engineOptions.flavor);
    graph = runtime.context();
    deviceId = await Promise.race([
      readDeviceId(),
      graph.then(() => new Promise<never>(() => {})),
    ]);
    await loadSharedSettings();
  } catch (err) {
    // A store the 2.x files couldn't be imported into, or that can't be
    // read: the doctor's findings say which file and what to do.
    const storeReport = await storeFailureReport(err, {
      ...engineOptions,
      version: app.getVersion(),
    });
    if (storeReport !== null) {
      dialog.showErrorBox(
        "Shigoto no Mori can't open its data",
        `${storeReport}\n\nRun \`${cliBinaryName(engineOptions.flavor)} doctor\` in a terminal for the repairs it offers.`,
      );
      app.exit(1);
      return;
    }
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
  // A crash, a force quit, or an OOM skips the quit's reap, so
  // anything the last session left running is reaped here. Claims the
  // record file synchronously (before any script can spawn) and does
  // the killing in the background.
  startOrphanScriptSweep();
  buildAppMenu();
  // Host liveness. Install the crash guards before
  // the window exists so an early fatal error is still caught, then
  // reconcile the login item to the saved keepReachable opt-in. The same
  // reconcile reruns after every clientConfig write (the write handler)
  // and every sign-in or sign-out (the account fan-out in
  // ipc/handlers.ts), making this the boot-time pass only.
  installChildProcessLogging();
  installFatalRecovery({ isShuttingDown });
  createWindow(takeRestartVisibility());
  reconcileLaunchAtLogin();
  rememberVisibilityAtShutdown();
  // The window is already up, so the graph delays only the background
  // machinery. A quit that came first has disposed it.
  await graph.catch((error: unknown) => {
    if (!quitting) log.error("[boot] the layer graph failed:", error);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// Every quit path lands here: the graph's shutdown runs its finalizers
// (hostLayer.ts), then `app.exit` ends the process without coming back
// through before-quit. A second quit while the graph closes is let
// through as Electron's own, the way out of a finalizer that hangs.
let quitting = false;

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  // An update install was already confirmed by the renderer's
  // installUpdate dialog, and a relaunch's cancelled quit would leave a
  // live app on a data dir that has moved.
  if (!isHurriedQuit() && !confirmBusyActionSync("quit")) {
    // When the user got here by closing the last window (close-X →
    // window-all-closed → app.quit()), the BrowserWindow is already
    // destroyed by the time before-quit fires. Restore it so the
    // canceled quit doesn't leave the app running headless with the
    // busy work still in progress. Cmd-Q / menu Quit reach before-quit
    // before any window is closed, so the recreate is a no-op there.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
    return;
  }
  quitting = true;
  if (isHurriedQuit()) rememberVisibilityForRestart();
  void runtime
    .dispose()
    .catch((error: unknown) => {
      log.error("[quit] a finalizer failed:", error);
    })
    .finally(() => app.exit(0));
});
