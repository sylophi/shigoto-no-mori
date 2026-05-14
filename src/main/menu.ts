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

const isMac = process.platform === "darwin";

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
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
          accelerator: "CmdOrCtrl+T",
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
