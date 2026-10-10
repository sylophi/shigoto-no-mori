import { useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import {
  SidebarTakeoverSlotView,
  SidebarTakeoverView,
} from "./SidebarTakeoverView";

// A page's own navigation, drawn in the app sidebar in the project
// tree's place: Settings' section list, the diff pages' file list (with
// the changes page's commit composer), the files page's folder tree.
// The main pane keeps its whole width for the page. The page portals in
// rather than handing the sidebar a node, so the list keeps the page's
// context (the device scope above all) and its state stays the page's
// own. A phone has no sidebar, so there each page shows its list its
// own way and this renders nothing.
//
// Two stores are the seam. The sidebar publishes its slot element once,
// so the page's list lands in it on the page's first render, and the
// slot shows whenever it holds something. The page also claims the
// sidebar while it is mounted, which steps the tree aside. A count
// rather than a flag, so one page's cleanup can't drop the next page's
// claim whichever order a navigation runs them in. Claimed in a layout
// effect, so the tree never paints for a frame beside the page's list.
const claims = createExternalStore(0);
const slot = createExternalStore<HTMLElement | null>(null);

export function useSidebarTakenOver(): boolean {
  return useExternalStore(claims) > 0;
}

// The sidebar's half: where the page's list lands. Shown by its own
// content rather than by the claim, so the list is laid out from its
// first commit and a reveal on mount (the open file's row) has a box
// to scroll. The list arrives from the right, a step in, as the slot
// is shown again, so it plays when a list replaces the tree. One page's
// list replacing another's (the Git page's tabs, each a route of its
// own) swaps in one commit, the slot never empty, so it stays still.
export function SidebarTakeoverSlot() {
  return <SidebarTakeoverSlotView slotRef={slot.publish} />;
}

// The page's half. The tree is gone while this is up, so the way out
// is the first row. It spans the row like the rows below it, so the
// whole width is the target and not just the word, less what `actions`
// (the list's own controls) take at its end. Its box passes the slot's
// flex column on, so a list sized with flex-1 still fills it.
export function SidebarTakeover({
  back,
  actions,
  children,
}: {
  back: { label: string; onClick: () => void };
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const phone = usePhoneLayout();
  useLayoutEffect(() => {
    if (phone) return;
    claims.publish(claims.get() + 1);
    return () => claims.publish(claims.get() - 1);
  }, [phone]);
  const target = useExternalStore(slot);
  if (phone || !target) return null;
  return createPortal(
    <SidebarTakeoverView back={back} actions={actions}>
      {children}
    </SidebarTakeoverView>,
    target,
  );
}
