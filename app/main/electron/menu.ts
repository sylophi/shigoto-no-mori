// Native application menu. Owns the keyboard shortcuts so the renderer doesn't
// have to register window-level listeners. Accelerators here fire regardless of
// which element has focus, and Electron dispatches them through the menu before
// the renderer sees them.
import {
  app,
  Menu,
  type MenuItemConstructorOptions,
  type BrowserWindow,
} from "electron";
import type { ContractModule } from "@shigomori/contracts/contract";
import { navContract } from "@shigomori/contracts/modules/nav";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
} from "@shigomori/contracts/types";
import type { LaunchToolMenuEntry } from "@shigomori/contracts/schemas";
import { setMenuImpl } from "../ipc/modules/menu";
import { broadcast } from "../ipc/register";
import { openWindow } from "./windows";

// ⌘1..⌘9 is the accelerator space; anything beyond is unreachable.
const MAX_LAUNCH_TOOL_SHORTCUTS = 9;

// The File menu's ⌘1..⌘9, each window's own. The renderer owns
// ordering (it ships whatever its visible LauncherRow is showing) so
// the menu and the row can never disagree, and the menu shows the
// focused window's. The click handler sends the id (not the index) so
// the renderer can't drift out of sync with the menu.
type LaunchTools = {
  readonly enabled: boolean;
  readonly entries: readonly LaunchToolMenuEntry[];
};
const NO_LAUNCH_TOOLS: LaunchTools = { enabled: false, entries: [] };
const launchToolsByWindow = new Map<number, LaunchTools>();
let focusedWindowId: number | null = null;

function shownLaunchTools(): LaunchTools {
  return focusedWindowId === null
    ? NO_LAUNCH_TOOLS
    : (launchToolsByWindow.get(focusedWindowId) ?? NO_LAUNCH_TOOLS);
}

function entriesEqual(
  a: readonly LaunchToolMenuEntry[],
  b: readonly LaunchToolMenuEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, i) => entry.id === b[i]?.id && entry.label === b[i]?.label,
  );
}

function sameLaunchTools(a: LaunchTools, b: LaunchTools): boolean {
  return a.enabled === b.enabled && entriesEqual(a.entries, b.entries);
}

// Rebuilds the menu when what it shows changed.
function showing(change: () => void): void {
  const before = shownLaunchTools();
  change();
  if (!sameLaunchTools(before, shownLaunchTools())) buildAppMenu();
}

function setLaunchToolsEnabled(
  windowId: number,
  enabled: boolean,
  entries?: readonly LaunchToolMenuEntry[],
): void {
  // No entries means "just toggle the enabled flag on whatever we last
  // displayed", so unmount cleanups can grey out the shortcuts without
  // erasing them.
  const current = launchToolsByWindow.get(windowId) ?? NO_LAUNCH_TOOLS;
  showing(() =>
    launchToolsByWindow.set(windowId, {
      enabled,
      entries: entries
        ? entries.slice(0, MAX_LAUNCH_TOOL_SHORTCUTS)
        : current.entries,
    }),
  );
}

export function installMenuImpl(): void {
  setMenuImpl(setLaunchToolsEnabled);
}

// The menu follows the focused window's tools.
export function noteMenuWindowFocused(windowId: number): void {
  showing(() => {
    focusedWindowId = windowId;
  });
}

export function forgetWindowMenu(windowId: number): void {
  showing(() => {
    launchToolsByWindow.delete(windowId);
    if (focusedWindowId === windowId) focusedWindowId = null;
  });
}

// Click handler that broadcasts to the focused window. Electron types
// the callback's window as BaseWindow (no webContents); every window
// this app creates is a BrowserWindow, so narrow once here. No-op when
// no window has focus.
function clickBroadcast<M extends ContractModule, K extends BroadcastKeys<M>>(
  module: M,
  key: K,
  payload: BroadcastProducerPayload<M, K>,
): MenuItemConstructorOptions["click"] {
  return (_item, focusedWindow) => {
    const wc = (focusedWindow as BrowserWindow | undefined)?.webContents;
    if (wc) broadcast(module, key, payload, wc);
  };
}

function launchToolMenuItems(): MenuItemConstructorOptions[] {
  const { enabled, entries } = shownLaunchTools();
  if (entries.length === 0) return [];
  return [
    { type: "separator" },
    ...entries.map(
      (entry, i): MenuItemConstructorOptions => ({
        label: entry.label,
        accelerator: `Cmd+${i + 1}`,
        enabled,
        click: clickBroadcast(navContract, "launchById", entry.id),
      }),
    ),
  ];
}

// Reload and devtools are developer tooling. A packaged build has no use
// for them, and ⌘R in prod throws away the renderer's state (mirrors the
// dev-only "Inspect Element" in the context menu). They are all the
// View menu holds, so a packaged build has no View menu.
function devViewMenu(): MenuItemConstructorOptions[] {
  if (app.isPackaged) return [];
  return [
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
    },
  ];
}

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Cmd+,",
          click: clickBroadcast(navContract, "openSettings", undefined),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "Cmd+N",
          click: () => openWindow("/"),
        },
        { type: "separator" },
        {
          label: "Add project…",
          accelerator: "Shift+Cmd+N",
          click: clickBroadcast(navContract, "addProject", undefined),
        },
        ...launchToolMenuItems(),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    ...devViewMenu(),
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
