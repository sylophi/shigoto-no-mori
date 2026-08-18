// Menu bar presence: a template-image tray icon plus a small popover
// window that lists every worktree with a status dot, so parallel work
// can be checked (and switched to) without bringing the app forward.
//
// The popover is the same renderer bundle as the main window, loaded
// with `?surface=tray` -- see renderer/index.tsx. That keeps one
// component tree and one theme system (both v1 and doubutsu, light and
// dark) instead of a second, separately-styled surface.
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  screen,
  Tray,
} from "electron";
import path from "node:path";
import { navContract } from "@shared/ipc/modules/nav";
import { trayContract } from "@shared/ipc/modules/tray";
import { setTrayImpl } from "../../ipc/modules/tray";
import { broadcast } from "../../ipc/register";
import { trayIcon } from "./icon";

// Card is 340; the window carries a 6px transparent gutter on each side
// so the panel's drop shadow (and doubutsu's sticker edge) has somewhere
// to land. Keep in sync with the `p-1.5` wrapper in TrayPanel.
const POPOVER_WIDTH = 352;
// Enough for the filter row plus the empty state; the renderer measures
// its content and asks for the real height on first paint.
const POPOVER_INITIAL_HEIGHT = 180;
const POPOVER_MAX_HEIGHT = 560;
// Breathing room between the menu bar and the popover's top edge.
const POPOVER_GAP = 4;
const SCREEN_MARGIN = 8;

// Summons the popover from anywhere. Deliberately a four-modifier combo:
// it is registered process-wide while the app runs, so it must not
// plausibly collide with anything the user already has bound.
const SUMMON_ACCELERATOR = "Control+Alt+Command+M";

interface TrayDeps {
  // The main window, or null if it has been closed. Closing it quits the
  // app (see main/index.ts), so in practice this is non-null for the
  // whole life of the tray.
  getMainWindow: () => BrowserWindow | null;
  createMainWindow: () => BrowserWindow;
}

let deps: TrayDeps | null = null;
let tray: Tray | null = null;
let popover: BrowserWindow | null = null;
let lastTrayBounds: Electron.Rectangle | null = null;
// A click on the tray icon while the popover is open arrives *after* the
// popover's own blur has hidden it, which would read as "the icon never
// closes the popover". Suppress a re-open that lands right after a hide.
let hiddenAt = 0;
const REOPEN_SUPPRESSION_MS = 250;

// Whether a popover window is alive. It is hidden rather than closed
// between openings, which suppresses Electron's `window-all-closed`
// event for the whole app -- callers that relied on that event have to
// know.
export function hasTrayPopover(): boolean {
  return popover !== null && !popover.isDestroyed();
}

function popoverUrl(): { url: string } | { file: string } {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set("surface", "tray");
    return { url: url.toString() };
  }
  return {
    file: path.join(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
    ),
  };
}

function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_INITIAL_HEIGHT,
    show: false,
    frame: false,
    // The panel paints its own rounded card; the window itself is a
    // transparent canvas so the corners aren't squared off by the shell.
    transparent: true,
    backgroundColor: "#00000000",
    // The panel draws its own shadow in CSS, which is what doubutsu
    // swaps for its sticker edge. A native shadow on top of that would
    // be a second, differently-shaped drop.
    hasShadow: false,
    // Resizable so the content-driven `setBounds` below is never fought
    // by AppKit's size constraints, with the width pinned so the only
    // dimension that can move is the one the renderer measures.
    resizable: true,
    minWidth: POPOVER_WIDTH,
    maxWidth: POPOVER_WIDTH,
    minHeight: 1,
    maxHeight: POPOVER_MAX_HEIGHT,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The popover spends nearly all its life hidden, and a throttled
      // renderer would hand back a stale list on the frame it is shown.
      // It is a small, mostly-idle document; the cost is negligible.
      backgroundThrottling: false,
    },
  });

  // "floating" keeps it above ordinary windows without outranking system
  // UI, and the workspace call lets it appear over a full-screen space
  // instead of yanking the user out of one.
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Same navigation lockdown as the main window: one local document,
  // external links go through the scheme-validated shell IPC.
  const webContents = win.webContents;
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, url) => {
    if (url !== webContents.getURL()) event.preventDefault();
  });

  const target = popoverUrl();
  if ("url" in target) {
    void win.loadURL(target.url);
  } else {
    void win.loadFile(target.file, { query: { surface: "tray" } });
  }

  // Click-away dismissal. DevTools steal focus from the popover, so
  // skip the auto-hide while they're open or the panel can't be
  // inspected at all.
  win.on("blur", () => {
    if (webContents.isDevToolsOpened()) return;
    hidePopover();
  });

  return win;
}

function clampHeight(height: number): number {
  return Math.max(1, Math.min(POPOVER_MAX_HEIGHT, Math.round(height)));
}

// Anchor the popover's top edge under the menu bar item, clamped into
// the work area of whichever display the tray icon lives on.
function positionPopover(win: BrowserWindow, height: number): void {
  const bounds = lastTrayBounds;
  const anchorX = bounds
    ? Math.round(bounds.x + bounds.width / 2)
    : screen.getPrimaryDisplay().workArea.x;
  const anchorY = bounds ? bounds.y + bounds.height : 0;
  const area = screen.getDisplayNearestPoint({
    x: anchorX,
    y: anchorY,
  }).workArea;
  const x = Math.max(
    area.x + SCREEN_MARGIN,
    Math.min(
      Math.round(anchorX - POPOVER_WIDTH / 2),
      area.x + area.width - POPOVER_WIDTH - SCREEN_MARGIN,
    ),
  );
  const y = Math.max(area.y, Math.round(anchorY + POPOVER_GAP));
  win.setBounds({ x, y, width: POPOVER_WIDTH, height });
}

function showPopover(): void {
  if (!popover || popover.isDestroyed()) return;
  positionPopover(popover, popover.getBounds().height);
  popover.show();
  popover.focus();
  broadcast(trayContract, "shown", undefined, popover.webContents);
}

function hidePopover(): void {
  if (!popover || popover.isDestroyed() || !popover.isVisible()) return;
  popover.hide();
  hiddenAt = Date.now();
}

function togglePopover(): void {
  if (!popover || popover.isDestroyed()) return;
  if (popover.isVisible()) {
    hidePopover();
    return;
  }
  if (Date.now() - hiddenAt < REOPEN_SUPPRESSION_MS) return;
  showPopover();
}

function showMainWindow(): BrowserWindow | null {
  if (!deps) return null;
  const existing = deps.getMainWindow();
  const win =
    existing && !existing.isDestroyed() ? existing : deps.createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Raising a window is not the same as activating the app on macOS:
  // without this the popover's own app stays behind whatever the user
  // was in.
  app.focus({ steal: true });
  return win;
}

// Navigate the main window. If it is still loading (only reachable on
// the recreate path) the broadcast waits for the document; a renderer
// that has painted has already subscribed.
function navigateMainWindow(
  key: "openWorktree" | "newWorktree",
  payload: { projectId: string; worktreeId?: string },
): void {
  hidePopover();
  const win = showMainWindow();
  if (!win) return;
  const send = () => {
    if (win.isDestroyed()) return;
    if (key === "openWorktree" && payload.worktreeId) {
      broadcast(
        navContract,
        "openWorktree",
        { projectId: payload.projectId, worktreeId: payload.worktreeId },
        win.webContents,
      );
    } else if (key === "newWorktree") {
      broadcast(
        navContract,
        "newWorktree",
        { projectId: payload.projectId },
        win.webContents,
      );
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function contextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: `Open ${app.name}`,
      click: () => {
        hidePopover();
        showMainWindow();
      },
    },
    { type: "separator" },
    { role: "quit" },
  ]);
}

export function installTrayImpl(trayDeps: TrayDeps): void {
  deps = trayDeps;
  setTrayImpl({
    resize: (height) => {
      if (!popover || popover.isDestroyed()) return;
      const next = clampHeight(height);
      if (popover.getBounds().height === next) return;
      positionPopover(popover, next);
    },
    close: hidePopover,
    revealWorktree: (projectId, worktreeId) => {
      navigateMainWindow("openWorktree", { projectId, worktreeId });
    },
    revealNewWorktree: (projectId) => {
      navigateMainWindow("newWorktree", { projectId });
    },
    toggleMainWindow: () => {
      hidePopover();
      const win = deps?.getMainWindow();
      if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
        win.hide();
        return false;
      }
      return showMainWindow() !== null;
    },
    mainWindowVisible: () => {
      const win = deps?.getMainWindow();
      return Boolean(win && !win.isDestroyed() && win.isVisible());
    },
  });
}

export function startTray(): void {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip(app.name);
  // No setContextMenu: on macOS that would make a plain left-click open
  // the native menu instead of the popover.
  tray.on("click", (_event, bounds) => {
    lastTrayBounds = bounds;
    togglePopover();
  });
  tray.on("right-click", (_event, bounds) => {
    lastTrayBounds = bounds;
    hidePopover();
    tray?.popUpContextMenu(contextMenu());
  });

  popover = createPopover();
  popover.on("closed", () => {
    popover = null;
  });

  // Process-scoped: unregistered below on quit, and Electron drops all
  // global shortcuts when the process exits either way. Nothing is
  // written to the system.
  const registered = globalShortcut.register(SUMMON_ACCELERATOR, () => {
    lastTrayBounds = tray?.getBounds() ?? lastTrayBounds;
    togglePopover();
  });
  if (!registered) {
    console.warn(
      `[tray] ${SUMMON_ACCELERATOR} is already taken; the menu bar icon still works`,
    );
  }

  app.on("will-quit", stopTray);
}

export function stopTray(): void {
  globalShortcut.unregister(SUMMON_ACCELERATOR);
  if (popover && !popover.isDestroyed()) popover.destroy();
  popover = null;
  tray?.destroy();
  tray = null;
}
