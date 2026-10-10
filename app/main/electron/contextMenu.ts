// The window's right-click menu, which Electron doesn't ship:
// electron-context-menu's, the platform's items for what was clicked
// (spelling, edit actions, Look Up, links, images, and Writing Tools
// and AutoFill on macOS), plus Open Link for a web link, and Inspect
// Element in dev.
import { isWebUrl } from "@shigomori/contracts/predicates/webUrl";
import { app, type BrowserWindow, shell } from "electron";
import contextMenu from "electron-context-menu";

export function attachContextMenu(window: BrowserWindow): void {
  contextMenu({
    window,
    showSearchWithGoogle: false,
    showSelectAll: true,
    showPasteAndMatchStyle: true,
    showInspectElement: !app.isPackaged,
    prepend: (_actions, params) => [
      {
        label: "Open Link",
        visible: isWebUrl(params.linkURL),
        click: () => void shell.openExternal(params.linkURL),
      },
    ],
  });
}
