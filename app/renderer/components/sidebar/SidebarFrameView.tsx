// The sidebar's frame, the pieces around its rows: the aside, the
// inbox's create row, the scroller, the pinned row's wrapper, the
// empty state, and the rows a listing shows while it loads or after it
// failed. Sidebar puts them around the live list, and a picture of the
// sidebar (lab/scenes) around a drawn one.
import type { ReactNode, Ref } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
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

// The inbox's create row: New worktree, and add project beside it. The
// inbox has no project headers to hang a + off, so creating lives here.
// px-2 like the rows below it, which is where v1 wants it. doubutsu
// pulls it in to its banner card, hence the slot.
export function InboxCreateRowView({
  button,
  addProject,
}: {
  // The New worktree button (NewWorktreeButton or NewWorktreeButtonView),
  // with whatever it floats.
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

export function SidebarScrollerView({
  ref,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      data-slot="sidebar-scroller"
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
    >
      {children}
    </div>
  );
}

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

// A row held still over the scroller (the open project's header), so
// it stays put as the rows scroll. It has no hover to track: the open
// project's title wears its actions at rest. The gap under it keeps
// the rows scrolling up from being cut off flush against the name.
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

// A project's worktrees while their listing loads, and when it failed.
export function WorktreeSkeletonRow() {
  return (
    <div className="space-y-1 px-2 py-1.5" aria-label="Loading worktrees">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-24" />
    </div>
  );
}

export function WorktreeErrorRow() {
  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      Couldn't load worktrees.
    </div>
  );
}
