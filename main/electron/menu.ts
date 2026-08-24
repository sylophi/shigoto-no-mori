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
import type { ContractModule } from "@shared/ipc/contract";
import { navContract } from "@shared/ipc/modules/nav";
import { projectLauncherContract } from "@shared/ipc/modules/projectLauncher";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
} from "@shared/ipc/types";
import type { LaunchToolMenuEntry } from "@shared/schemas";
import { setMenuImpl } from "../ipc/modules/menu";
import { broadcast } from "../ipc/register";

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
  if (currentLaunchToolEntries.length === 0) return [];
  return [
    { type: "separator" },
    ...currentLaunchToolEntries.map(
      (entry, i): MenuItemConstructorOptions => ({
        label: entry.label,
        accelerator: `Cmd+${i + 1}`,
        enabled: currentLaunchToolsEnabled,
        click: clickBroadcast(navContract, "launchById", entry.id),
      }),
    ),
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
          label: "Add project…",
          accelerator: "Cmd+N",
          click: clickBroadcast(
            projectLauncherContract,
            "addProject",
            undefined,
          ),
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
    {
      label: "View",
      submenu: [
        {
          label: "Project launcher",
          accelerator: "Cmd+Shift+P",
          click: clickBroadcast(projectLauncherContract, "toggle", undefined),
        },
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
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
