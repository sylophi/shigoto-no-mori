// The sidebar's frame (Sidebar binds it): the aside, the forest's slot
// beside a page's takeover, and the parts of a view's pane, which a
// scene composes into a sidebar of its own.
import { useState, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/utils";
import { ARRIVE_FROM } from "./sidebarChrome";
import { ROW_LAYOUT, type SidebarRow } from "./sidebarRow";

// Both themes are fully transparent so the BrowserWindow vibrancy
// material shows through. A heavy white wash in light mode washes out
// the chroma, so we let the "sidebar" material do its job on its own.
// The `data-sidebar` attribute scopes the token overrides in index.css
// to this surface only.
export function SidebarAsideView({ children }: { children: ReactNode }) {
  return (
    <aside
      data-sidebar
      data-doubutsu-zone="sidebar"
      className="flex h-full flex-col"
    >
      {children}
    </aside>
  );
}

// The forest and the footer. Hidden rather than unmounted while a page
// holds the sidebar, so the forest keeps its place (the open project,
// the shelves) for the way back. Showing it again replays the arrival.
export function ForestSlotView({
  takenOver,
  handedOver,
  children,
}: {
  takenOver: boolean;
  // A page has held the sidebar before, so the forest arrives back.
  handedOver: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        takenOver
          ? "hidden"
          : cn("flex min-h-0 flex-1 flex-col", handedOver && ARRIVE_FROM.left)
      }
    >
      {children}
    </div>
  );
}

// The view's own part of the forest, below the filter both views
// share. A flip plays across it, the tree being the inbox's right-hand
// neighbour as on the toggle. Only once the view is settled, so the
// saved one replacing the default after the first paint is no flip.
export function ViewPaneView({
  inbox,
  settled,
  children,
}: {
  inbox: boolean;
  settled: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState({
    inbox: settled ? inbox : null,
    flipped: false,
  });
  if (settled && shown.inbox !== inbox) {
    setShown({ inbox, flipped: shown.inbox !== null });
  }
  return (
    <div
      // Remounted per view so a flip plays.
      key={inbox ? "inbox" : "projects"}
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        shown.flipped && ARRIVE_FROM[inbox ? "left" : "right"],
      )}
    >
      {children}
    </div>
  );
}

// The inbox has no project headers to hang a + off, so creating lives
// here: New worktree, and add project beside it. px-2 like the rows
// below it, which is where v1 wants it. doubutsu pulls it in to its
// banner card, hence the slot.
export function InboxCreateRowView({
  button,
  addProject,
}: {
  button: ReactNode;
  addProject: ReactNode;
}) {
  return (
    <div
      data-slot="sidebar-inbox-create"
      className="flex items-center gap-1 px-2 pb-1.5"
    >
      <div className="min-w-0 flex-1">{button}</div>
      {addProject}
    </div>
  );
}

// The open project's title over the scroller, so it stays put as the
// rows scroll. It has no hover to track: it wears its actions at rest.
// The gap under it keeps the rows scrolling up from being cut off flush
// against the name.
export function PinnedRowView({
  kind,
  children,
}: {
  kind: SidebarRow["kind"];
  children: ReactNode;
}) {
  return (
    <div data-slot="sidebar-row" className={cn(ROW_LAYOUT[kind], "pb-1")}>
      {children}
    </div>
  );
}

export function SidebarScrollerView({
  scrollerRef,
  children,
}: {
  scrollerRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={scrollerRef}
      data-slot="sidebar-scroller"
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
    >
      {children}
    </div>
  );
}

// What the forest says when it has nothing to list (emptyForestMessage),
// and what to do about it.
export function SidebarEmptyStateView({
  message,
  children,
}: {
  message: string | null;
  children?: ReactNode;
}) {
  if (!message) return null;
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-muted-foreground">
      {message}
      {children}
    </div>
  );
}
