// The app's windows. Each is a client of this machine's host of its
// own: its page builds a runtime over its links (the shell's port and
// the loopback, renderer/lib/runtime) and subscribes to what it shows,
// so nothing here or in the host waits on one window. The shell keeps
// the set: the route each window opened on and shows now, its pending
// deep link, the order they were focused in. A deep link opens in the
// window focused last, or a new one if none is open. At a quit each
// window's route and bounds are remembered (windows.json in userData)
// and the next start opens them again, one window on the home route
// when there is nothing to bring back, or on the first run's page until
// the install is past it (ClientConfig.welcomed). The app quits with its last
// window (main/index.ts).
import { join } from "node:path";
import { app, BrowserWindow, dialog, type Rectangle, screen } from "electron";
import * as Schema from "effect/Schema";
import { windowContract } from "@shigomori/contracts/modules/window";
import { navContract } from "@shigomori/contracts/modules/nav";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { log } from "@shared/log";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
} from "@host/lib/util/atomicJson";
import {
  APP_VERSION_FLAG,
  CLERK_PK_FLAG,
  DEV_BUILD_FLAG,
  ROUTE_FLAG,
} from "../argFlags";
import { noteWindowFocused } from "../hostProcess";
import { clerkPublishableKey } from "../ipc/modules/account";
import { broadcast } from "../ipc/register";
import { rendererSchemeUrl } from "./clerk";
import { applyThemeSource, readClientConfigSync } from "./clientConfig";
import { attachContextMenu } from "./contextMenu";
import { attachRenderProcessRecovery } from "./liveness";
import { forgetWindowMenu, noteMenuWindowFocused } from "./menu";
import {
  applyRestartVisibility,
  type RestartVisibility,
} from "./restartVisibility";

const HOME_ROUTE = "/";
// A fresh install's first run (renderer/lib/routePaths.ts).
const WELCOME_ROUTE = "/welcome";

// How far a new window sits from the one it opened from, so it does
// not cover it exactly.
const CASCADE = 24;

const BoundsSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

const RememberedSchema = Schema.Array(
  Schema.Struct({
    route: Schema.String,
    bounds: BoundsSchema,
    minimized: Schema.Boolean,
  }),
);
type Remembered = (typeof RememberedSchema.Type)[number];

type Held = {
  readonly window: BrowserWindow;
  // The window's webContents id, kept past its destruction.
  readonly id: number;
  route: string;
  // Where it is, kept as it moves: a window that closed is asked
  // nothing.
  bounds: Rectangle;
  minimized: boolean;
  // A deep link it has not taken yet (renderer/hooks/ui/useDeepLinks.ts).
  deepLink: string | null;
  // Its renderer kept crashing and recovery gave up: a live handle on a
  // dead page, never raised.
  dead: boolean;
};

// Least recently focused first.
const held: Held[] = [];

// The last window as it closed, which a quit that closing it started
// remembers, and a cancelled one reopens.
let lastClosed: Remembered | null = null;

// Set once the boot's windows are open. A link that came before them
// (one that launched the app) waits for them.
let started = false;
let launchLink: string | null = null;

let isShuttingDown: () => boolean = () => false;

function rememberedPath(): string {
  return join(app.getPath("userData"), "windows.json");
}

function find(windowId: number): Held | undefined {
  return held.find((entry) => entry.id === windowId);
}

function recordOf(entry: Held): Remembered {
  return {
    route: entry.route,
    bounds: entry.bounds,
    minimized: entry.minimized,
  };
}

// Whether any display still shows part of `bounds`: one remembered on
// a display since unplugged opens at its size, placed afresh.
function onScreen(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    const left = Math.max(bounds.x, workArea.x);
    const top = Math.max(bounds.y, workArea.y);
    const right = Math.min(
      bounds.x + bounds.width,
      workArea.x + workArea.width,
    );
    const bottom = Math.min(
      bounds.y + bounds.height,
      workArea.y + workArea.height,
    );
    return right - left > 0 && bottom - top > 0;
  });
}

function placement(bounds: Rectangle | undefined): Partial<Rectangle> {
  if (bounds === undefined) return { width: 920, height: 720 };
  return onScreen(bounds)
    ? bounds
    : { width: bounds.width, height: bounds.height };
}

// The window focused last that still has a page, if any.
function frontmost(): Held | undefined {
  for (let i = held.length - 1; i >= 0; i--) {
    const entry = held[i];
    if (
      entry !== undefined &&
      !entry.dead &&
      !entry.window.isDestroyed() &&
      !entry.window.webContents.isCrashed()
    ) {
      return entry;
    }
  }
  return undefined;
}

function create(
  route: string,
  options: {
    readonly bounds?: Rectangle;
    readonly restart?: {
      readonly visibility: RestartVisibility;
      readonly minimized: boolean;
    };
  } = {},
): Held {
  // Drive the native appearance from the saved theme before constructing
  // the window so the macOS vibrancy material picks the right light/dark
  // variant on first paint. Absent or "system" delegates back to the OS.
  applyThemeSource(readClientConfigSync().theme);
  const window = new BrowserWindow({
    ...placement(options.bounds),
    minWidth: 640,
    minHeight: 420,
    show: options.restart === undefined,
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
      preload: join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Facts about this client build, read synchronously by the
      // preload off process.argv. isDev is the build showing the
      // window, never the host's, so it must not travel via
      // runtime.info.
      additionalArguments: [
        // This build's version: the renderer sends it in the link's
        // hello and compares it against a remote host's for skew.
        `${APP_VERSION_FLAG}${app.getVersion()}`,
        // The resolved Clerk publishable key (empty when the build is
        // unconfigured), so the renderer can mount or skip the
        // ClerkProvider synchronously at boot.
        `${CLERK_PK_FLAG}${clerkPublishableKey()}`,
        // The page the window opens on.
        `${ROUTE_FLAG}${route}`,
        ...(app.isPackaged ? [] : [DEV_BUILD_FLAG]),
      ],
    },
  });
  const entry: Held = {
    window,
    id: window.webContents.id,
    route,
    bounds: window.getNormalBounds(),
    minimized: false,
    deepLink: null,
    dead: false,
  };
  held.push(entry);

  // The renderer is a single local document with in-memory routing, so
  // no in-page navigation or popup is ever legitimate. External links go
  // through the scheme-validated shell:openExternal IPC instead. Same-URL
  // navigation stays allowed so the dev server's full reload still works.
  const webContents = window.webContents;
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, url) => {
    if (url !== webContents.getURL()) event.preventDefault();
  });

  // Both modes load over the renderer scheme rather than file:// or the
  // vite http origin. Clerk requires it (see main/electron/clerk.ts).
  void window.loadURL(rendererSchemeUrl());

  // Relay BrowserWindow focus/blur to the renderer. The web-level `focus`
  // and `visibilitychange` events don't fire on every Electron focus
  // transition (notably ⌘Tab between apps), so React Query's
  // refetch-on-focus needs this signal to be reliable. The host's
  // background fetch ticks while any window is focused.
  window.on("focus", () => {
    held.splice(held.indexOf(entry), 1);
    held.push(entry);
    broadcast(windowContract, "focused", undefined, webContents);
    noteWindowFocused(true);
    noteMenuWindowFocused(entry.id);
  });
  window.on("blur", () => {
    broadcast(windowContract, "blurred", undefined, webContents);
    // Focus moving to another of ours blurs this one first.
    setImmediate(() =>
      noteWindowFocused(BrowserWindow.getFocusedWindow() !== null),
    );
  });
  const place = () => {
    entry.bounds = window.getNormalBounds();
    entry.minimized = window.isMinimized();
  };
  window.on("resize", place);
  window.on("move", place);
  window.on("minimize", place);
  window.on("restore", place);
  window.on("closed", () => {
    const at = held.indexOf(entry);
    if (at !== -1) held.splice(at, 1);
    if (held.length === 0) lastClosed = recordOf(entry);
    forgetWindowMenu(entry.id);
  });

  // Recover the page from a renderer crash: a new window where it was,
  // then the crashed one goes, leaving no ghost behind. The recreate
  // budget lives in the liveness module and is the app's, so a crash
  // loop across windows still gives up.
  attachRenderProcessRecovery(window, {
    isShuttingDown,
    recreateWindow: () => {
      create(entry.route, { bounds: entry.bounds });
      if (!window.isDestroyed()) window.destroy();
    },
    onGiveUp: () => {
      entry.dead = true;
      showCrashGiveUpDialog();
    },
  });

  attachContextMenu(window);
  if (options.restart !== undefined) {
    applyRestartVisibility(
      window,
      options.restart.visibility,
      options.restart.minimized,
    );
  }
  return entry;
}

// Last resort when the renderer crash-loops: stop recreating and tell the
// user, rather than thrash a window that dies as fast as it opens.
function showCrashGiveUpDialog(): void {
  dialog.showErrorBox(
    "Shigoto no Mori keeps crashing",
    "The window crashed several times in a row, so it was not reopened " +
      "to avoid a crash loop. Quit and relaunch the app. If it keeps " +
      "happening, restart your machine or reinstall.",
  );
}

// A new window on `route`, cascaded off the window focused last.
export function openWindow(route: string): void {
  const from = frontmost()?.window.getNormalBounds();
  create(
    route,
    from === undefined
      ? {}
      : { bounds: { ...from, x: from.x + CASCADE, y: from.y + CASCADE } },
  );
}

// The boot's windows: the ones the last quit remembered, in the order
// they were focused, or one on the home route. A restart the user did
// not ask for brings them back hidden or minimized as they were
// (restartVisibility.ts).
export function openWindowsAtStart(options: {
  readonly restart: RestartVisibility | null;
  readonly isShuttingDown: () => boolean;
}): void {
  isShuttingDown = options.isShuttingDown;
  started = true;
  let remembered: readonly Remembered[] = [];
  try {
    remembered = readJsonOrNullSync(rememberedPath(), RememberedSchema) ?? [];
  } catch (error) {
    log.warn(`[windows] could not read the windows: ${errorMessageOf(error)}`);
  }
  const restartOf = (minimized: boolean) =>
    options.restart === null
      ? {}
      : { restart: { visibility: options.restart, minimized } };
  if (remembered.length === 0) {
    create(
      readClientConfigSync().welcomed === true ? HOME_ROUTE : WELCOME_ROUTE,
      restartOf(false),
    );
  }
  for (const record of remembered) {
    create(record.route, {
      bounds: record.bounds,
      ...restartOf(record.minimized),
    });
  }
  if (launchLink !== null) {
    const route = launchLink;
    launchLink = null;
    openDeepLink(route);
  }
}

// Remembers every open window, or the last one if closing it is what
// quits. Never throws: it runs on the way out.
export function rememberWindows(): void {
  const records =
    held.length > 0
      ? held.filter((entry) => !entry.dead).map(recordOf)
      : lastClosed === null
        ? []
        : [lastClosed];
  try {
    atomicWriteJsonSync(rememberedPath(), records);
  } catch (error) {
    log.warn(
      `[windows] could not remember the windows: ${errorMessageOf(error)}`,
    );
  }
}

// A quit the user cancelled after closing the last window: that window
// again, so the app is not left running with none.
export function reopenIfNone(): void {
  if (held.length > 0) return;
  const record = lastClosed;
  if (record === null) create(HOME_ROUTE);
  else create(record.route, { bounds: record.bounds });
}

// A new window on `route` where the windows with no page left were
// (a renderer that crashed, or that recovery gave up on), which then
// go, leaving no ghost behind.
function replaceDead(route: string): void {
  const dead = [...held];
  const last = dead.at(-1);
  create(route, last === undefined ? {} : { bounds: last.bounds });
  for (const entry of dead) {
    if (!entry.window.isDestroyed()) entry.window.destroy();
  }
}

// Launching the app again while it runs is a request to see it: the
// window focused last, or a new one when none has a page. Before the
// boot's windows there is nothing to raise: they are on their way.
export function surfaceWindow(): void {
  const entry = frontmost();
  if (entry === undefined) {
    if (started) replaceDead(held.at(-1)?.route ?? HOME_ROUTE);
  } else {
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    entry.window.focus();
  }
  // macOS won't raise a background app just because one of its windows
  // asked for focus, and the launch the user just made is already gone.
  app.focus({ steal: true });
}

// A deep link (main/electron/deepLink.ts) or a notification's click:
// the window focused last takes it, raised, or a new window opens on
// it. One that comes before the windows waits for them.
export function openDeepLink(route: string): void {
  if (!started) {
    launchLink = route;
    return;
  }
  const entry = frontmost();
  if (entry === undefined) {
    replaceDead(route);
  } else {
    // A later link replaces an untaken one: the user wants the page
    // they asked for last.
    entry.deepLink = route;
    broadcast(navContract, "deepLink", undefined, entry.window.webContents);
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    entry.window.focus();
  }
  app.focus({ steal: true });
}

export function takeDeepLink(windowId: number | undefined): string | null {
  const entry = windowId === undefined ? undefined : find(windowId);
  if (entry === undefined) return null;
  const route = entry.deepLink;
  entry.deepLink = null;
  return route;
}

export function noteShowing(windowId: number | undefined, route: string): void {
  const entry = windowId === undefined ? undefined : find(windowId);
  if (entry !== undefined) entry.route = route;
}
