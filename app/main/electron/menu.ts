// Native application menu. Its items' keys are the focused window's
// keymap (renderer/hooks/ui/useKeymap.ts), which each window hands over
// as it binds them (setChords), so an item has none until a window has.
// Accelerators here fire regardless of which element has focus, and
// Electron dispatches them through the menu before the renderer sees
// them.
import { menuAccelerators } from "@shigomori/ui/lib/keymap.ts";
import { readClientConfigSync } from "./clientConfig";
import {
  app,
  Menu,
  type MenuItemConstructorOptions,
  type BrowserWindow,
} from "electron";
import type { ContractModule } from "@shigomori/contracts/contract";
import { navContract } from "@shigomori/contracts/modules/nav";
import {
  askAboutTheApp,
  type GuideChoices,
  guideChoicesKey,
} from "@shigomori/contracts/modules/guide";
import type { PushKeys, PushProducerPayload } from "@shigomori/contracts/types";
import type { LaunchToolMenuEntry } from "@shigomori/contracts/schemas";
import { broadcast } from "../ipc/register";
import { openWindow, raisePageWindow } from "./windows";

// The keymap has nine launch tools, so anything beyond is unreachable.
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

// The focused window's, or the device's stored bindings over the
// defaults until a window has focus and has sent its own, so the menu
// shows its keys from launch.
function shownChords(): Chords {
  return (
    (focusedWindowId === null
      ? undefined
      : chordsByWindow.get(focusedWindowId)) ??
    menuAccelerators(readClientConfigSync().keybindings)
  );
}

// The Help menu's guides: what each window's device offers, the
// focused window's shown.
const guideChoicesByWindow = new Map<number, GuideChoices>();
const NO_GUIDES: GuideChoices = { harnesses: [], terminals: [] };

function shownGuideChoices(): GuideChoices {
  return (
    (focusedWindowId === null
      ? undefined
      : guideChoicesByWindow.get(focusedWindowId)) ?? NO_GUIDES
  );
}

// The windows whose focus a terminal holds, which take ⌘W for its tab.
const terminalFocused = new Set<number>();

export function setTerminalFocused(windowId: number, focused: boolean): void {
  if (focused) terminalFocused.add(windowId);
  else terminalFocused.delete(windowId);
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
  const guides = shownGuideChoices();
  change();
  if (
    !sameLaunchTools(tools, shownLaunchTools()) ||
    !sameChords(chords, shownChords()) ||
    guideChoicesKey(guides) !== guideChoicesKey(shownGuideChoices())
  ) {
    buildAppMenu();
  }
}

export function setLaunchToolsEnabled(
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

export function setChords(windowId: number, chords: Chords): void {
  showing(() => chordsByWindow.set(windowId, chords));
}

export function setGuideChoices(windowId: number, choices: GuideChoices): void {
  showing(() => guideChoicesByWindow.set(windowId, choices));
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
    guideChoicesByWindow.delete(windowId);
    terminalFocused.delete(windowId);
    if (focusedWindowId === windowId) focusedWindowId = null;
  });
}

function guideItems({
  harnesses,
  terminals,
}: GuideChoices): MenuItemConstructorOptions[] {
  return harnesses.map((harness) => ({
    label: askAboutTheApp(harness),
    ...(terminals.length === 0
      ? { click: clickBroadcast(navContract, "showAround", { harness }) }
      : {
          submenu: terminals.map(({ id, label }) => ({
            label,
            click: clickBroadcast(navContract, "showAround", {
              harness,
              terminal: id,
            }),
          })),
        }),
  }));
}

// Click handler that broadcasts to the focused window. Electron types
// the callback's window as BaseWindow (no webContents), but every window
// this app creates is a BrowserWindow, so narrow once here. No-op when
// no window has focus.
function clickBroadcast<M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
  payload: PushProducerPayload<M, K>,
): MenuItemConstructorOptions["click"] {
  return (_item, focusedWindow) => {
    const wc = (focusedWindow as BrowserWindow | undefined)?.webContents;
    if (wc) broadcast(module, key, payload, wc);
  };
}

// An app-wide item: to the window that can show any page, which a
// focused terminals window can't.
function pageBroadcast<M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
  payload: PushProducerPayload<M, K>,
): MenuItemConstructorOptions["click"] {
  return () => {
    const wc = raisePageWindow();
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
          click: pageBroadcast(navContract, "openSettings", undefined),
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
          label: "Add Project…",
          accelerator: chords.addProject,
          click: pageBroadcast(navContract, "addProject", undefined),
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
        {
          label: "Close",
          accelerator: "Cmd+W",
          click: (_item, focusedWindow) => {
            if (!focusedWindow) return;
            const wc = (focusedWindow as BrowserWindow).webContents;
            if (terminalFocused.has(wc.id)) {
              broadcast(navContract, "closeTab", undefined, wc);
            } else {
              focusedWindow.close();
            }
          },
        },
        { type: "separator" },
        { role: "front" },
      ],
    },
    {
      role: "help",
      // The guide, one item for each harness installed here, which asks
      // for a terminal when there are any to ask between.
      submenu: guideItems(shownGuideChoices()),
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
