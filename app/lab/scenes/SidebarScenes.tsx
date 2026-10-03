// The sidebar over the lab's fixtures, as the live lab draws it at its
// default pose (?updates=, nothing waiting): LabSidebar for composing,
// and the scenes that put it in a window.
import type { ReactNode } from "react";
import { ForestPageView } from "@/components/ForestPageView";
import { AddProjectButtonView } from "@/components/sidebar/AddProjectButtonView";
import { ALL_DEVICES } from "@/components/sidebar/DeviceFilterBarView";
import {
  NewWorktreeButtonView,
  NewWorktreeMenuView,
} from "@/components/sidebar/inbox/NewWorktreeButtonView";
import {
  SidebarToolbarView,
  SortTriggerView,
} from "@/components/sidebar/SidebarToolbarView";
import {
  InboxCreateRowView,
  SidebarView,
} from "@/components/sidebar/SidebarView";
import type { SidebarView as SidebarViewKind } from "@shared/schemas";
import { AppWindowScene } from "./AppWindowScene";
import {
  deviceFilterChoices,
  groupKeyOfWorktree,
  labInboxRows,
  labNewWorktreeTargets,
  labRowLookups,
  labTreeRows,
  type LabShell,
} from "./world";

// happy-hummingbird, brave-badger and the main checkout, on Studio Mac.
const HAPPY_HUMMINGBIRD = "5a0000000002";
const BRAVE_BADGER = "5a0000000003";
const MAIN_CHECKOUT = "5a0000000001";

export interface LabSidebarProps {
  shell?: LabShell;
  view?: SidebarViewKind;
  // The worktree whose page is open, by id, or null for none. The tree
  // opens that worktree's project. With none it lists the projects.
  selected?: string | null;
  // The inbox's New worktree button lit as its menu's trigger, and
  // anchoring it (NewWorktreeMenuOverlay draws the menu).
  newWorktreeMenu?: boolean;
  // A dev build's marks on the brand header (the lab's own build).
  dev?: boolean;
  // The footer, which the phone layout's forest page goes without.
  footer?: boolean;
  // The page open in the main pane, by route, whose button the footer
  // lights (the Devices page's, say).
  activePath?: string;
}

export function LabSidebar({
  shell = "desktop",
  view = "inbox",
  selected = null,
  newWorktreeMenu = false,
  dev = true,
  footer = true,
  activePath,
}: LabSidebarProps) {
  const hasLocalHost = shell === "desktop";
  const inbox = view === "inbox";
  const openKey =
    inbox || selected === null ? null : groupKeyOfWorktree(shell, selected);
  const model = inbox ? labInboxRows(shell) : labTreeRows(shell, openKey);
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
  return (
    <SidebarView
      shell={shell}
      showDevStyle={dev}
      view={view}
      filter={{ choices: deviceFilterChoices(shell), selectedId: ALL_DEVICES }}
      top={top}
      rows={model.rows}
      pinned={model.pinned}
      lookups={labRowLookups(shell, selected)}
      emptyMessage={model.emptyMessage}
      footer={footer && { updateReady: false, activePath }}
    />
  );
}

// The desktop window with the sidebar in the inbox, happy-hummingbird's
// page open. The page is the caller's (children), empty by default.
export function SidebarInboxScene({
  selected = HAPPY_HUMMINGBIRD,
  children,
}: {
  selected?: string | null;
  children?: ReactNode;
}) {
  return (
    <AppWindowScene sidebar={<LabSidebar view="inbox" selected={selected} />}>
      {children}
    </AppWindowScene>
  );
}

// The same window with the sidebar's tree inside shigoto-no-mori, on
// brave-badger's page.
export function SidebarTreeScene({
  selected = BRAVE_BADGER,
  children,
}: {
  selected?: string | null;
  children?: ReactNode;
}) {
  return (
    <AppWindowScene
      sidebar={<LabSidebar view="projects" selected={selected} />}
    >
      {children}
    </AppWindowScene>
  );
}

// The New worktree button's anchor, which its menu hangs from.
const NEW_WORKTREE_ANCHOR = "--new-worktree";

// The New worktree menu open, listing every project it can create in.
// The live one is portaled out of the sidebar, so it reads the window's
// tokens rather than the sidebar's: this one is drawn in the window
// too, beside the sidebar, and hung under its button's start, 4px off
// it, by the button's anchor (LabSidebar's newWorktreeMenu).
export function NewWorktreeMenuOverlay({
  shell = "desktop",
}: {
  shell?: LabShell;
}) {
  return (
    <NewWorktreeMenuView
      targets={labNewWorktreeTargets(shell)}
      // Where the anchor puts it in a desktop window, for a browser
      // without anchor positioning, which drops the style's anchor()
      // values and keeps these. Both count from the window's corner,
      // so the window is the menu's containing block (relative).
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

// The inbox on the main checkout's page with the New worktree menu
// open, the Thinkpad's projects among its targets.
export function NewWorktreeMenuScene({
  selected = MAIN_CHECKOUT,
  children,
}: {
  selected?: string | null;
  children?: ReactNode;
}) {
  return (
    <AppWindowScene
      sidebar={<LabSidebar view="inbox" selected={selected} newWorktreeMenu />}
      overlays={<NewWorktreeMenuOverlay />}
    >
      {children}
    </AppWindowScene>
  );
}

// The web shell on a phone (390x844): the inbox tab, every forest a
// peer of the browser, over the tab bar.
export function PhoneScene() {
  return (
    <AppWindowScene shell="web" phone>
      <ForestPageView>
        <LabSidebar shell="web" view="inbox" footer={false} />
      </ForestPageView>
    </AppWindowScene>
  );
}
