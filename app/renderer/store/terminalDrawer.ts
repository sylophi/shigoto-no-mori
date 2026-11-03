// The terminal drawer of a worktree's pages, this window's. For each
// worktree it keeps whether it is open (so its pages come back as they
// were left, and visiting one opens no shell there), the script
// consoles opened in it as tabs, and the tab picked. Every drawer
// shares its height at the bottom and width at the side, each null
// until it is dragged and kept across launches, and the edge it is
// docked to (a store of its own, which the pages read). A tab is named
// by a terminal's id, or `script:` and its slot's param.
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import { readStored, removeStored, writeStored } from "@/lib/localStorage";
import { slotToParam, type ScriptSlot } from "./scriptSlot";
import {
  createWorktreeStore,
  useWorktreeStore,
  type WorktreeRef,
} from "./worktreeState";

type Drawer = {
  readonly open: boolean;
  // The scripts' slots, as params, in the order they were opened.
  readonly scripts: readonly string[];
  readonly picked: string | null;
};

const CLOSED: Drawer = { open: false, scripts: [], picked: null };

const drawers = createWorktreeStore<Drawer>({ empty: CLOSED, moves: false });

export const useDrawer = (ref: WorktreeRef): Drawer =>
  useWorktreeStore(drawers, ref);

const HEIGHT_KEY = "terminalDrawer.height";
const WIDTH_KEY = "terminalDrawer.width";
const readSize = (key: string): number | null =>
  Number(readStored(key)) || null;

const sizeStore = createExternalStore<{
  readonly height: number | null;
  readonly width: number | null;
}>({ height: readSize(HEIGHT_KEY), width: readSize(WIDTH_KEY) });

export const useDrawerSizes = () => useExternalStore(sizeStore);

// Docked at the side rather than the bottom, kept across launches.
const SIDE_KEY = "terminalDrawer.side";
const sideStore = createExternalStore(readStored(SIDE_KEY) === "true");

export const useDrawerSide = () => useExternalStore(sideStore);

// The tab a script's console is.
export const scriptTabId = (slot: ScriptSlot): string =>
  `script:${slotToParam(slot)}`;

// A terminal's tab, named for its place among its worktree's terminals
// (oldest first, as its host lists them).
export const terminalTabLabel = (index: number): string =>
  `Terminal ${index + 1}`;

export function setDrawerOpen(ref: WorktreeRef, open: boolean): void {
  drawers.update(ref, (drawer) => ({ ...drawer, open }));
}

// A worktree's last terminal closed away from its drawer (on Live): with
// no console in it either, the drawer hides as it does when its own
// last tab closes, so the next visit opens no shell.
export function hideEmptyDrawer(ref: WorktreeRef): void {
  const drawer = drawers.get(ref);
  if (drawer.open && drawer.scripts.length === 0) setDrawerOpen(ref, false);
}

export function pickDrawerTab(ref: WorktreeRef, tab: string): void {
  drawers.update(ref, (drawer) => ({ ...drawer, picked: tab }));
}

// Opens the drawer on a terminal's tab.
export function openTerminalTab(ref: WorktreeRef, terminalId: string): void {
  drawers.update(ref, (drawer) => ({
    ...drawer,
    open: true,
    picked: terminalId,
  }));
}

// Opens the drawer on a script's console, its tab added if it has none.
export function openScriptTab(ref: WorktreeRef, slot: ScriptSlot): void {
  const param = slotToParam(slot);
  drawers.update(ref, (drawer) => ({
    open: true,
    scripts: drawer.scripts.includes(param)
      ? drawer.scripts
      : [...drawer.scripts, param],
    picked: scriptTabId(slot),
  }));
}

export function closeScriptTab(ref: WorktreeRef, slot: ScriptSlot): void {
  const param = slotToParam(slot);
  drawers.update(ref, (drawer) => ({
    ...drawer,
    scripts: drawer.scripts.filter((open) => open !== param),
  }));
}

export const forgetDrawer = drawers.forget;

export function setDrawerSide(side: boolean): void {
  writeStored(SIDE_KEY, String(side));
  sideStore.publish(side);
}

// The height at the bottom, or the width at the side.
export function setDrawerSize(size: number): void {
  const sizes = sizeStore.get();
  const side = sideStore.get();
  writeStored(side ? WIDTH_KEY : HEIGHT_KEY, String(size));
  sizeStore.publish(
    side ? { ...sizes, width: size } : { ...sizes, height: size },
  );
}

export function resetDrawerSizes(): void {
  removeStored(HEIGHT_KEY);
  removeStored(WIDTH_KEY);
  sizeStore.publish({ height: null, width: null });
}
