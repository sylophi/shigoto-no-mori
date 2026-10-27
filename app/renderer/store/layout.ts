// The sizes the user drags in a page, kept across launches: the
// sidebar's width and the terminal drawer's (terminalDrawer.ts).
// resetLayout puts them back to their defaults. The terminals window's
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
import { resetDrawerSizes } from "./terminalDrawer";

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

export function resetLayout(): void {
  removeStored(SIDEBAR_KEY);
  sidebarStore.publish(SIDEBAR_DEFAULT);
  resetDrawerSizes();
}
