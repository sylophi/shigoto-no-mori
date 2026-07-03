// Native application menu. Owns the keyboard shortcuts so the renderer doesn't
// have to register window-level listeners — accelerators here fire regardless
// of which element has focus, and Electron dispatches them through the menu
// before the renderer sees them.
import {
  app,
  Menu,
  type MenuItemConstructorOptions,
  type BrowserWindow,
} from "electron";
import type { Contract } from "@shared/ipc/contract";
import { navContract } from "@shared/ipc/modules/nav";
import { paletteContract } from "@shared/ipc/modules/palette";
import type { BroadcastProducerPayload } from "@shared/ipc/types";
import type { LaunchToolMenuEntry } from "@shared/schemas";
import { setMenuImpl } from "../ipc/modules/menu";
import { broadcast } from "../ipc/register";

const isMac = process.platform === "darwin";

// ⌘1..⌘9 is the accelerator space; anything beyond is unreachable.
const MAX_LAUNCH_TOOL_SHORTCUTS = 9;

// Sticky entries for the File menu's ⌘1..⌘9. The renderer owns ordering
// (it ships whatever the visible LauncherRow is showing) so the menu and
// the row can never disagree. The click handler sends the id (not the
// index) so the renderer can't drift out of sync with the menu.
let currentLaunchToolEntries: LaunchToolMenuEntry[] = [];
let currentLaunchToolsEnabled = false;

function entriesEqual(
  a: LaunchToolMenuEntry[],
  b: LaunchToolMenuEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].label !== b[i].label) return false;
  }
  return true;
}

export function setLaunchToolsEnabled(
  enabled: boolean,
  entries?: LaunchToolMenuEntry[],
): void {
  // No entries means "just toggle the enabled flag on whatever we last
  // displayed", so unmount cleanups can grey out the shortcuts without
  // erasing them.
  const nextEntries = entries
    ? entries.slice(0, MAX_LAUNCH_TOOL_SHORTCUTS)
    : currentLaunchToolEntries;
  const unchanged =
    enabled === currentLaunchToolsEnabled &&
    entriesEqual(nextEntries, currentLaunchToolEntries);
  if (unchanged) return;
  currentLaunchToolsEnabled = enabled;
  currentLaunchToolEntries = nextEntries;
  buildAppMenu();
}

export function installMenuImpl(): void {
  setMenuImpl(setLaunchToolsEnabled);
}

// Click handler that broadcasts to the focused window. Electron types
// the callback's window as BaseWindow (no webContents); every window
// this app creates is a BrowserWindow, so narrow once here. No-op when
// no window has focus.
function clickBroadcast<C extends Contract, K extends keyof C>(
  contract: C,
  key: K,
  payload: BroadcastProducerPayload<C, K>,
): MenuItemConstructorOptions["click"] {
  return (_item, focusedWindow) => {
    const wc = (focusedWindow as BrowserWindow | undefined)?.webContents;
    if (wc) broadcast(contract, key, payload, wc);
  };
}

// Shared between the mac app menu and the non-mac File menu.
const SETTINGS_MENU_ITEM: MenuItemConstructorOptions = {
  label: "Settings…",
  accelerator: "CmdOrCtrl+,",
  click: clickBroadcast(navContract, "openSettings", undefined),
};

function launchToolMenuItems(): MenuItemConstructorOptions[] {
  if (currentLaunchToolEntries.length === 0) return [];
  return [
    { type: "separator" },
    ...currentLaunchToolEntries.map(
      (entry, i): MenuItemConstructorOptions => ({
        label: entry.label,
        accelerator: `CmdOrCtrl+${i + 1}`,
        enabled: currentLaunchToolsEnabled,
        click: clickBroadcast(navContract, "launchById", entry.id),
      }),
    ),
  ];
}

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              SETTINGS_MENU_ITEM,
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
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Add project…",
          accelerator: "CmdOrCtrl+N",
          click: clickBroadcast(paletteContract, "addProject", undefined),
        },
        ...launchToolMenuItems(),
        // Without a mac-style app menu, File carries Settings and Exit
        // (the conventional Windows/Linux placement).
        ...(isMac
          ? ([] satisfies MenuItemConstructorOptions[])
          : ([
              { type: "separator" },
              SETTINGS_MENU_ITEM,
              { type: "separator" },
              { role: "quit", label: "Exit" },
            ] satisfies MenuItemConstructorOptions[])),
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
    {
      label: "View",
      submenu: [
        {
          label: "Command palette",
          accelerator: "CmdOrCtrl+Shift+P",
          click: clickBroadcast(paletteContract, "toggle", undefined),
        },
        // Hidden synonym so ⌘P also opens the palette. Electron only keeps
        // accelerators live for hidden items on macOS, and on other
        // platforms the behavior is inconsistent -- so the item exists
        // only on mac, and everywhere else the renderer's Ctrl+P listener
        // in CommandPalette.tsx owns the shortcut outright (no double
        // handling).
        ...(isMac
          ? ([
              {
                label: "Command palette (alt)",
                accelerator: "CmdOrCtrl+P",
                visible: false,
                click: clickBroadcast(paletteContract, "toggle", undefined),
              },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
        ...(isMac
          ? ([
              { type: "separator" },
              { role: "front" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    // The About entry lives in the app menu on macOS; elsewhere it gets
    // the conventional Help menu slot.
    ...(isMac
      ? ([] satisfies MenuItemConstructorOptions[])
      : ([
          {
            label: "Help",
            submenu: [{ role: "about" }],
          },
        ] satisfies MenuItemConstructorOptions[])),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
