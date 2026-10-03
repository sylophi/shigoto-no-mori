// The sidebar drawn whole from data, for a picture of it (lab/scenes),
// and the frame pieces it shares with the live one (Sidebar): the
// aside, the inbox's create row, the scroller and the empty state.
import type { ReactNode, Ref } from "react";
import type { SidebarView as SidebarViewKind } from "@shared/schemas";
import {
  DeviceFilterBarView,
  type DeviceFilterChoice,
} from "./DeviceFilterBarView";
import {
  SidebarFooterView,
  SidebarNavActionsView,
  SidebarViewToggleView,
} from "./SidebarFooterView";
import { SidebarHeaderView } from "./SidebarHeaderView";
import { RowContentView, type SidebarRowLookups } from "./RowContentView";
import { PinnedRowView, SidebarListView } from "./SidebarListView";
import type { SidebarRow } from "./sidebarRow";

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

interface SidebarViewProps {
  // The desktop window (a machine of its own, a title bar) or a browser
  // tab (hostless, every forest a peer's).
  shell: "desktop" | "web";
  // Which view the forest is in: what the footer's toggle shows picked.
  view: SidebarViewKind;
  // The device filter's machines and pick (DeviceFilterBarView).
  filter: { choices: readonly DeviceFilterChoice[]; selectedId: string };
  // What the view puts over its list: the inbox's create row
  // (InboxCreateRowView) or the tree's toolbar (SidebarToolbarView).
  top: ReactNode;
  // The rows (buildInboxRows, buildSidebarRows) and what they look up.
  // `pinned` is the open project's header, held over the list.
  rows: readonly SidebarRow[];
  pinned?: SidebarRow;
  lookups: SidebarRowLookups;
  // Shown under the rows when there are none worth showing.
  emptyMessage?: string | null;
  // The footer, with the route on screen for the button it lights, or
  // false for none (the phone layout, whose tab bar carries its
  // cluster).
  footer: { activePath?: string } | false;
}

// The sidebar as a release build's Sidebar draws it once settled, with
// no update waiting: the brand header, the device filter, the view's
// own controls and rows, and the footer.
export function SidebarView({
  shell,
  view,
  filter,
  top,
  rows,
  pinned,
  lookups,
  emptyMessage = null,
  footer,
}: SidebarViewProps) {
  const hasLocalHost = shell === "desktop";
  const row = (r: SidebarRow) => <RowContentView row={r} lookups={lookups} />;
  return (
    <SidebarAsideView>
      <SidebarHeaderView hasLocalHost={hasLocalHost} showDevStyle={false} />
      <div className="flex min-h-0 flex-1 flex-col">
        <DeviceFilterBarView {...filter} />
        <div className="flex min-h-0 flex-1 flex-col">
          {top}
          {pinned && (
            <PinnedRowView kind={pinned.kind}>{row(pinned)}</PinnedRowView>
          )}
          <SidebarScrollerView>
            <SidebarListView rows={rows} renderRow={row} />
            <SidebarEmptyStateView message={emptyMessage} />
          </SidebarScrollerView>
        </div>
        {footer && (
          <SidebarFooterView
            toggle={<SidebarViewToggleView view={view} />}
            actions={
              <SidebarNavActionsView
                hasLocalHost={hasLocalHost}
                updateReady={false}
                activePath={footer.activePath}
              />
            }
          />
        )}
      </div>
    </SidebarAsideView>
  );
}
