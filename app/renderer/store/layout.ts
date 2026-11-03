// The sizes the user drags in a page, kept across launches: the
// sidebar's width, and the terminal drawer's height at the bottom and
// width at the side, each null until dragged and shared by every
// worktree's drawer. resetLayout puts them back to their defaults. The terminals window's
// size is the shell's (window:resetLayout).
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "@shigomori/ui/views/AppShellView.tsx";
import { readStored, removeStored, writeStored } from "@/lib/localStorage";

const SIDEBAR_KEY = "sidebar.width";

const clampSidebar = (width: number): number =>
  Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width));

const sidebarStore = createExternalStore(
  clampSidebar(Number(readStored(SIDEBAR_KEY)) || SIDEBAR_DEFAULT),
);

export const useSidebarWidth = () => useExternalStore(sidebarStore);

export function setSidebarWidth(width: number): void {
  const clamped = clampSidebar(Math.round(width));
  writeStored(SIDEBAR_KEY, String(clamped));
  sidebarStore.publish(clamped);
}

const HEIGHT_KEY = "terminalDrawer.height";
const WIDTH_KEY = "terminalDrawer.width";
const readSize = (key: string): number | null =>
  Number(readStored(key)) || null;

const drawerSizeStore = createExternalStore<{
  readonly height: number | null;
  readonly width: number | null;
}>({ height: readSize(HEIGHT_KEY), width: readSize(WIDTH_KEY) });

export const useDrawerSizes = () => useExternalStore(drawerSizeStore);

// The width when docked at the side, the height otherwise.
export function setDrawerSize(side: boolean, size: number): void {
  const sizes = drawerSizeStore.get();
  writeStored(side ? WIDTH_KEY : HEIGHT_KEY, String(size));
  drawerSizeStore.publish(
    side ? { ...sizes, width: size } : { ...sizes, height: size },
  );
}

export function resetLayout(): void {
  removeStored(SIDEBAR_KEY);
  sidebarStore.publish(SIDEBAR_DEFAULT);
  removeStored(HEIGHT_KEY);
  removeStored(WIDTH_KEY);
  drawerSizeStore.publish({ height: null, width: null });
}
