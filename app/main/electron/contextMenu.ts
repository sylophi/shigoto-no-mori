// The window's right-click menu, which Electron doesn't ship:
// electron-context-menu's items for what was clicked (spelling, Look
// Up, edit actions, images, links, and Writing Tools and AutoFill on
// macOS), with Open Link for a web link, Undo and Redo in a text field,
// Select All in a text field or over a selection, and Inspect Element
// in dev.
import { isWebUrl } from "@shigomori/contracts/predicates/webUrl";
import { app, type BrowserWindow, shell } from "electron";
import contextMenu from "electron-context-menu";

export function attachContextMenu(window: BrowserWindow): void {
  contextMenu({
    window,
    showFileUrlItems: true,
    menu: (actions, params, _window, suggestions) => {
      const { isEditable, editFlags } = params;
      const hasSelection = params.selectionText.trim().length > 0;
      return [
        ...suggestions,
        actions.separator(),
        actions.learnSpelling(),
        actions.separator(),
        {
          label: "Open Link",
          visible: isWebUrl(params.linkURL),
          click: () => void shell.openExternal(params.linkURL),
        },
        actions.copyLink(),
        actions.separator(),
        { role: "undo", visible: isEditable, enabled: editFlags.canUndo },
        { role: "redo", visible: isEditable, enabled: editFlags.canRedo },
        actions.separator(),
        actions.cut(),
        actions.copy(),
        actions.paste(),
        actions.pasteAndMatchStyle(),
        {
          ...actions.selectAll(),
          visible: isEditable || hasSelection,
        },
        actions.separator(),
        actions.lookUpSelection(),
        actions.separator(),
        actions.copyImage(),
        actions.separator(),
        { ...actions.inspect(), visible: !app.isPackaged },
      ];
    },
  });
}
