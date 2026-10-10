// The worktree page's terminal drawer, this window's: which worktrees
// have it open (so a page comes back as it was left, and visiting one
// opens no shell there), and the one height they share.
import { createExternalStore, useExternalStore } from "./externalStore";

type DrawerState = {
  readonly open: ReadonlySet<string>;
  readonly height: number;
};

const store = createExternalStore<DrawerState>({
  open: new Set(),
  height: 280,
});

export const useTerminalDrawer = () => useExternalStore(store);

export function setDrawerOpen(key: string, open: boolean): void {
  const state = store.get();
  if (state.open.has(key) === open) return;
  const next = new Set(state.open);
  if (open) next.add(key);
  else next.delete(key);
  store.publish({ ...state, open: next });
}

export function setDrawerHeight(height: number): void {
  store.publish({ ...store.get(), height });
}
