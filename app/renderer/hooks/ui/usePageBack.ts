import { useEffectEvent, useLayoutEffect } from "react";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";

interface PageBack {
  label: string;
  onClick: () => void;
}

// A page stacked on another stacked page (a worktree's changes, its
// files) names its own way back, and the phone's back bar shows it in
// place of the forest tab's (AppShell). A wide window's is the
// sidebar's first row (SidebarTakeover).
const pageBack = createExternalStore<PageBack | null>(null);

export function usePageBack(): PageBack | null {
  return useExternalStore(pageBack);
}

export function useClaimPageBack(label: string, onClick: () => void): void {
  const go = useEffectEvent(onClick);
  // A layout effect, so the bar never paints the forest tab's label for
  // a frame. The cleanup lets go of its own claim alone: the next
  // page's may already be in.
  useLayoutEffect(() => {
    const mine = { label, onClick: () => go() };
    pageBack.publish(mine);
    return () => {
      if (pageBack.get() === mine) pageBack.publish(null);
    };
  }, [label]);
}
