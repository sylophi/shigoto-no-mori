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
import { CHANNELS } from "@shared/channels";
import { getLaunchersForProject } from "./ipc/launchers";

const isMac = process.platform === "darwin";

// ⌘1..⌘9 is the accelerator space; anything beyond is unreachable.
const MAX_LAUNCH_TOOL_SHORTCUTS = 9;

interface LaunchToolEntry {
  id: string;
  label: string;
}

// Sticky entries for the File menu's ⌘1..⌘9. Computed in main from the same
// ordering source as LauncherRow's buttons. The click handler sends the id
// (not the index) so the renderer can't drift out of sync with the menu.
let currentLaunchToolEntries: LaunchToolEntry[] = [];
let currentLaunchToolsEnabled = false;

function entriesEqual(a: LaunchToolEntry[], b: LaunchToolEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].label !== b[i].label) return false;
  }
  return true;
}

export async function setLaunchToolsEnabled(
  enabled: boolean,
  projectId?: string,
): Promise<void> {
  let nextEntries = currentLaunchToolEntries;
  if (enabled && projectId) {
    try {
      const entries = await getLaunchersForProject(projectId);
      nextEntries = entries
        .slice(0, MAX_LAUNCH_TOOL_SHORTCUTS)
        .map((e) => ({ id: e.id, label: e.label }));
    } catch (err) {
      console.warn(
        `setLaunchToolsEnabled: lookup failed for ${projectId}`,
        err,
      );
    }
  }
  const unchanged =
    enabled === currentLaunchToolsEnabled &&
    entriesEqual(nextEntries, currentLaunchToolEntries);
  if (unchanged) return;
  currentLaunchToolsEnabled = enabled;
  currentLaunchToolEntries = nextEntries;
  buildAppMenu();
}

function launchToolMenuItems(): MenuItemConstructorOptions[] {
  if (currentLaunchToolEntries.length === 0) return [];
  return [
    { type: "separator" },
    ...currentLaunchToolEntries.map(
      (entry, i): MenuItemConstructorOptions => ({
        label: entry.label,
        accelerator: `CmdOrCtrl+${i + 1}`,
        enabled: currentLaunchToolsEnabled,
        click: (_item, focusedWindow) => {
          (focusedWindow as BrowserWindow | undefined)?.webContents.send(
            CHANNELS.LaunchById,
            entry.id,
          );
        },
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
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: (_item, focusedWindow) => {
                  (
                    focusedWindow as BrowserWindow | undefined
                  )?.webContents.send(CHANNELS.NavOpenSettings);
                },
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
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Add project…",
          accelerator: "CmdOrCtrl+N",
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send(
              CHANNELS.PaletteAddProject,
            );
          },
        },
        ...launchToolMenuItems(),
        ...(isMac
          ? ([] satisfies MenuItemConstructorOptions[])
          : ([
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: (_item, focusedWindow) => {
                  (
                    focusedWindow as BrowserWindow | undefined
                  )?.webContents.send(CHANNELS.NavOpenSettings);
                },
              },
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
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send(
              CHANNELS.PaletteToggle,
            );
          },
        },
        // Hidden synonym so ⌘P also opens the palette. Electron keeps the
        // accelerator live for hidden items on macOS; for cross-platform
        // reliability we'd need a renderer-side listener.
        {
          label: "Command palette (alt)",
          accelerator: "CmdOrCtrl+P",
          visible: false,
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send(
              CHANNELS.PaletteToggle,
            );
          },
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
        ...(isMac
          ? ([
              { type: "separator" },
              { role: "front" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
