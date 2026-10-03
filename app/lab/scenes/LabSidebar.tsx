// The sidebar over the lab's fixtures, as a release build's Sidebar
// draws it once settled at the lab's default pose (nothing running, no
// update waiting), for composing a window (LabWindow): the brand
// header, the device filter, the view's own controls and rows, and the
// footer.
import { AddProjectButtonView } from "@/components/sidebar/AddProjectButtonView";
import {
  ALL_DEVICES,
  DeviceFilterBarView,
} from "@/components/sidebar/DeviceFilterBarView";
import {
  NewWorktreeButtonView,
  NewWorktreeMenuView,
} from "@/components/sidebar/inbox/NewWorktreeButtonView";
import {
  SidebarToolbarView,
  SortTriggerView,
} from "@/components/sidebar/SidebarToolbarView";
import {
  SidebarFooterView,
  SidebarNavActionsView,
  SidebarViewToggleView,
} from "@/components/sidebar/SidebarFooterView";
import {
  InboxCreateRowView,
  PinnedRowView,
  SidebarAsideView,
  SidebarEmptyStateView,
  SidebarScrollerView,
} from "@/components/sidebar/SidebarFrameView";
import { SidebarHeaderView } from "@/components/sidebar/SidebarHeaderView";
import type { SidebarView as SidebarViewKind } from "@shared/schemas";
import { SidebarRowContent, SidebarRows } from "./SidebarRows";
import type { LabShell } from "./world";
import {
  deviceFilterChoices,
  groupKeyOfWorktree,
  inboxRows,
  newWorktreeTargets,
  rowLookups,
  treeRows,
} from "./world/sidebar";

export function LabSidebar({
  shell = "desktop",
  view,
  selected = null,
  newWorktreeMenu = false,
  footer = true,
  activePath,
}: {
  shell?: LabShell;
  view: SidebarViewKind;
  // The worktree whose page is open, by id, or null for none. The tree
  // opens that worktree's project. With none it lists the projects.
  selected?: string | null;
  // The inbox's New worktree button lit as its menu's trigger, and
  // anchoring it (NewWorktreeMenuOverlay draws the menu).
  newWorktreeMenu?: boolean;
  // The footer, which the phone layout's forest page goes without.
  footer?: boolean;
  // The page open in the main pane, by route, whose button the footer
  // lights (the Devices page's, say).
  activePath?: string;
}) {
  const hasLocalHost = shell === "desktop";
  const inbox = view === "inbox";
  const openKey =
    inbox || selected === null ? null : groupKeyOfWorktree(shell, selected);
  const model = inbox ? inboxRows(shell) : treeRows(shell, openKey);
  const top = inbox ? (
    <InboxCreateRowView
      button={
        newWorktreeMenu ? (
          <NewWorktreeButtonView
            aria-label="New worktree"
            aria-haspopup="menu"
            aria-expanded
            data-popup-open=""
            style={{ anchorName: NEW_WORKTREE_ANCHOR }}
          />
        ) : (
          <NewWorktreeButtonView aria-label="New worktree" />
        )
      }
      addProject={<AddProjectButtonView outline hasLocalHost={hasLocalHost} />}
    />
  ) : (
    <SidebarToolbarView
      back={openKey === null ? undefined : { onBack: () => {} }}
      sort={
        openKey !== null ? (
          <SortTriggerView tip="Sort worktrees" />
        ) : (
          hasLocalHost && <SortTriggerView tip="Sort projects" />
        )
      }
      addProject={<AddProjectButtonView hasLocalHost={hasLocalHost} />}
    />
  );
  const lookups = rowLookups(shell, selected);
  return (
    <SidebarAsideView>
      {/* A release build's header, without a dev build's marks. */}
      <SidebarHeaderView hasLocalHost={hasLocalHost} showDevStyle={false} />
      <div className="flex min-h-0 flex-1 flex-col">
        <DeviceFilterBarView
          choices={deviceFilterChoices(shell)}
          selectedId={ALL_DEVICES}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {top}
          {model.pinned && (
            <PinnedRowView kind={model.pinned.kind}>
              <SidebarRowContent row={model.pinned} lookups={lookups} />
            </PinnedRowView>
          )}
          <SidebarScrollerView>
            <SidebarRows rows={model.rows} lookups={lookups} />
            <SidebarEmptyStateView message={model.emptyMessage ?? null} />
          </SidebarScrollerView>
        </div>
        {footer && (
          <SidebarFooterView
            toggle={<SidebarViewToggleView view={view} />}
            actions={
              <SidebarNavActionsView
                hasLocalHost={hasLocalHost}
                updateReady={false}
                activePath={activePath}
              />
            }
          />
        )}
      </div>
    </SidebarAsideView>
  );
}

// The New worktree button's anchor, which its menu hangs from.
const NEW_WORKTREE_ANCHOR = "--new-worktree";

// The New worktree menu open, listing every project it can create in.
// The live one is portaled out of the sidebar, so it reads the window's
// tokens rather than the sidebar's: this one is drawn in the window
// too (LabWindow's overlays), and hung under its button's start, 4px
// off it, by the button's anchor (LabSidebar's newWorktreeMenu).
export function NewWorktreeMenuOverlay({
  shell = "desktop",
}: {
  shell?: LabShell;
}) {
  return (
    <NewWorktreeMenuView
      targets={newWorktreeTargets(shell)}
      // Where the anchor puts it in a desktop window, for a browser
      // without anchor positioning, which drops the style's anchor()
      // values and keeps these. Both count from the window's corner.
      className="top-[196px] left-3"
      style={{
        position: "absolute",
        positionAnchor: NEW_WORKTREE_ANCHOR,
        top: "anchor(bottom)",
        left: "anchor(left)",
        marginTop: 4,
      }}
    />
  );
}
