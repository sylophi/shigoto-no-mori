// Native application menu. Its items' keys are the focused window's
// keymap (renderer/hooks/ui/useKeymap.ts), which each window hands over
// as it binds them (setChords), so an item has none until a window has.
// Accelerators here fire regardless of which element has focus, and
// Electron dispatches them through the menu before the renderer sees
// them.
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

// The keymap's launch tools are nine; anything beyond is unreachable.
const MAX_LAUNCH_TOOL_SHORTCUTS = 9;

// The File menu's launch tools, each window's own. The renderer owns
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

// Each window's keys for the menu's actions, by the keymap's ids.
type Chords = Readonly<Record<string, string>>;
const chordsByWindow = new Map<number, Chords>();

function shownChords(): Chords {
  return focusedWindowId === null
    ? {}
    : (chordsByWindow.get(focusedWindowId) ?? {});
}

function sameChords(a: Chords, b: Chords): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
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
  const tools = shownLaunchTools();
  const chords = shownChords();
  change();
  if (
    !sameLaunchTools(tools, shownLaunchTools()) ||
    !sameChords(chords, shownChords())
  ) {
    buildAppMenu();
  }
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

function setChords(windowId: number, chords: Chords): void {
  showing(() => chordsByWindow.set(windowId, chords));
}

export function installMenuImpl(): void {
  setMenuImpl({ setLaunchToolsEnabled, setChords });
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
    chordsByWindow.delete(windowId);
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
  const chords = shownChords();
  if (entries.length === 0) return [];
  return [
    { type: "separator" },
    ...entries.map(
      (entry, i): MenuItemConstructorOptions => ({
        label: entry.label,
        accelerator: chords[`launchTool${i + 1}`],
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
  const chords = shownChords();
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: chords.settings,
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
          accelerator: chords.newWindow,
          click: () => openWindow("/"),
        },
        { type: "separator" },
        {
          label: "Add project…",
          accelerator: chords.addProject,
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
    {
      role: "help",
      submenu: [
        {
          label: "Ask How…",
          click: clickBroadcast(navContract, "askHow", undefined),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
