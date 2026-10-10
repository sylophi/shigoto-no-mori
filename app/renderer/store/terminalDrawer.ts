// The worktree page's terminal drawer, this window's: for each worktree
// whether it is open (so a page comes back as it was left, and visiting
// one opens no shell there), the script consoles opened in it as tabs,
// and the tab picked; and the one height every drawer shares. A tab is
// named by a terminal's id, or `script:` and its slot's param.
import { createExternalStore, useExternalStore } from "./externalStore";
import { slotToParam, type ScriptSlot } from "./scriptSlot";

type Drawer = {
  readonly open: boolean;
  // The scripts' slots, as params, in the order they were opened.
  readonly scripts: readonly string[];
  readonly picked: string | null;
};

type DrawerState = {
  readonly drawers: ReadonlyMap<string, Drawer>;
  readonly height: number;
};

const CLOSED: Drawer = { open: false, scripts: [], picked: null };

const store = createExternalStore<DrawerState>({
  drawers: new Map(),
  height: 280,
});

export const useTerminalDrawer = () => useExternalStore(store);

export const drawerOf = (state: DrawerState, key: string): Drawer =>
  state.drawers.get(key) ?? CLOSED;

// The tab a script's console is.
export const scriptTabId = (slot: ScriptSlot): string =>
  `script:${slotToParam(slot)}`;

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

export function pickDrawerTab(key: string, tab: string): void {
  update(key, (drawer) => ({ ...drawer, picked: tab }));
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

export function setDrawerHeight(height: number): void {
  store.publish({ ...store.get(), height });
}
