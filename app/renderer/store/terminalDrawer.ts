// The worktree page's terminal drawer, this window's. For each worktree
// it keeps whether it is open (so a page comes back as it was left, and
// visiting one opens no shell there), the script consoles opened in it
// as tabs, and the tab picked. Every drawer shares its height at the
// bottom and width at the side, each null until it is dragged, and the
// edge it is docked to (a store of its own, which the page reads). A
// tab is named by a terminal's id, or `script:` and its slot's param.
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import { readStored, writeStored } from "@/lib/localStorage";
import { slotToParam, type ScriptSlot } from "./scriptSlot";

type Drawer = {
  readonly open: boolean;
  // The scripts' slots, as params, in the order they were opened.
  readonly scripts: readonly string[];
  readonly picked: string | null;
};

type DrawerState = {
  readonly drawers: ReadonlyMap<string, Drawer>;
  readonly height: number | null;
  readonly width: number | null;
};

const CLOSED: Drawer = { open: false, scripts: [], picked: null };

const store = createExternalStore<DrawerState>({
  drawers: new Map(),
  height: null,
  width: null,
});

export const useTerminalDrawer = () => useExternalStore(store);

// Docked at the side rather than the bottom, kept across launches.
const SIDE_KEY = "terminalDrawer.side";
const sideStore = createExternalStore(readStored(SIDE_KEY) === "true");

export const useDrawerSide = () => useExternalStore(sideStore);

export const drawerOf = (state: DrawerState, key: string): Drawer =>
  state.drawers.get(key) ?? CLOSED;

// The tab a script's console is.
export const scriptTabId = (slot: ScriptSlot): string =>
  `script:${slotToParam(slot)}`;

// A terminal's tab, named for its place among its worktree's terminals
// (oldest first, as its host lists them).
export const terminalTabLabel = (index: number): string =>
  `Terminal ${index + 1}`;

// The key a worktree's drawer is kept by, on the device it lives on.
export const drawerKey = (
  deviceId: string,
  projectId: string,
  worktreeId: string,
): string => `${deviceId}/${projectId}/${worktreeId}`;

function update(key: string, change: (drawer: Drawer) => Drawer): void {
  const state = store.get();
  const drawers = new Map(state.drawers);
  drawers.set(key, change(drawerOf(state, key)));
  store.publish({ ...state, drawers });
}

export function setDrawerOpen(key: string, open: boolean): void {
  update(key, (drawer) => ({ ...drawer, open }));
}

// A worktree's last terminal closed away from its drawer (on Live): with
// no console in it either, the drawer hides as it does when its own
// last tab closes, so the next visit opens no shell.
export function hideEmptyDrawer(key: string): void {
  const drawer = drawerOf(store.get(), key);
  if (drawer.open && drawer.scripts.length === 0) setDrawerOpen(key, false);
}

export function pickDrawerTab(key: string, tab: string): void {
  update(key, (drawer) => ({ ...drawer, picked: tab }));
}

// Opens the drawer on a terminal's tab.
export function openTerminalTab(key: string, terminalId: string): void {
  update(key, (drawer) => ({ ...drawer, open: true, picked: terminalId }));
}

// Opens the drawer on a script's console, its tab added if it has none.
export function openScriptTab(key: string, slot: ScriptSlot): void {
  const param = slotToParam(slot);
  update(key, (drawer) => ({
    open: true,
    scripts: drawer.scripts.includes(param)
      ? drawer.scripts
      : [...drawer.scripts, param],
    picked: scriptTabId(slot),
  }));
}

export function closeScriptTab(key: string, slot: ScriptSlot): void {
  const param = slotToParam(slot);
  update(key, (drawer) => ({
    ...drawer,
    scripts: drawer.scripts.filter((open) => open !== param),
  }));
}

export function setDrawerSide(side: boolean): void {
  writeStored(SIDE_KEY, String(side));
  sideStore.publish(side);
}

// The height at the bottom, or the width at the side.
export function setDrawerSize(size: number): void {
  const state = store.get();
  store.publish(
    sideStore.get() ? { ...state, width: size } : { ...state, height: size },
  );
}

export function forgetDrawer(key: string): void {
  const state = store.get();
  if (!state.drawers.has(key)) return;
  const drawers = new Map(state.drawers);
  drawers.delete(key);
  store.publish({ ...state, drawers });
}
