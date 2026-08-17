// Right-click context menu for the renderer. Electron doesn't ship a default
// one, so without this nothing happens when the user right-clicks selected
// text or an input. We listen to webContents' context-menu event and build a
// native popup tailored to what was clicked: spellcheck suggestions, edit
// actions on inputs, copy/look-up/search on plain selections, link actions,
// and Inspect Element in dev.
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";
import { isWebUrl } from "@shared/webUrl";

// Cap inline label text so a paragraph-sized selection doesn't blow out the
// menu. Matches what Safari/Chrome show.
const MAX_LABEL_LEN = 32;

function truncateForLabel(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= MAX_LABEL_LEN) return single;
  return single.slice(0, MAX_LABEL_LEN - 1) + "…";
}

export function attachContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];

    const hasSelection = params.selectionText.trim().length > 0;
    const isEditable = params.isEditable;

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          items.push({
            label: suggestion,
            click: () => window.webContents.replaceMisspelling(suggestion),
          });
        }
        items.push({ type: "separator" });
      }
      items.push({
        label: "Add to Dictionary",
        click: () =>
          window.webContents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord,
          ),
      });
      items.push({ type: "separator" });
    }

    if (params.linkURL) {
      if (isWebUrl(params.linkURL)) {
        items.push({
          label: "Open Link",
          click: () => {
            void shell.openExternal(params.linkURL);
          },
        });
      }
      items.push({
        label: "Copy Link Address",
        click: () => clipboard.writeText(params.linkURL),
      });
      items.push({ type: "separator" });
    }

    if (isEditable) {
      items.push({ role: "undo", enabled: params.editFlags.canUndo });
      items.push({ role: "redo", enabled: params.editFlags.canRedo });
      items.push({ type: "separator" });
      items.push({ role: "cut", enabled: params.editFlags.canCut });
      items.push({ role: "copy", enabled: params.editFlags.canCopy });
      items.push({ role: "paste", enabled: params.editFlags.canPaste });
      items.push({
        role: "pasteAndMatchStyle",
        enabled: params.editFlags.canPaste,
      });
      items.push({ type: "separator" });
      items.push({
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      });
    } else if (hasSelection) {
      items.push({ role: "copy", enabled: params.editFlags.canCopy });
      items.push({
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      });
    }

    if (hasSelection && !isEditable) {
      const label = truncateForLabel(params.selectionText);
      items.push({ type: "separator" });
      items.push({
        label: `Look Up “${label}”`,
        click: () => window.webContents.showDefinitionForSelection(),
      });
    }

    if (!app.isPackaged) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({
        label: "Inspect Element",
        click: () => {
          window.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window });
  });
}
