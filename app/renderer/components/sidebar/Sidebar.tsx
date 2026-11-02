import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { SidebarView } from "@shigomori/contracts/schemas";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { useReorderProjects } from "@/hooks/projects/useProjects";
import { useClientFlag } from "@/hooks/config/useSidebarMarks";
import {
  useSidebarView,
  useSidebarViewHotkey,
  useSidebarViewSettled,
} from "@/hooks/projects/useSidebarView";
import { useHasLocalHost } from "@/lib/localHost";
import {
  useFanOutErrorToast,
  useUnreachedDevicesToast,
} from "./useFanOutErrorToast";
import { buildSidebarRows } from "@shigomori/ui/views/sidebar/buildSidebarRows.ts";
import { useForestSources } from "./forestSources";
import { DeviceFilterBar } from "./DeviceFilterBar";
import { buildInboxRows } from "@shigomori/ui/views/sidebar/inbox/buildInboxRows.ts";
import { useShareInboxOrder } from "./inbox/inboxOrder";
import { NewWorktreeButton } from "./inbox/NewWorktreeButton";
import { useLeaveInboxForPage } from "./inbox/useLeaveInboxForPage";
import { setOpenProject, useOpenProject } from "./openProject";
import { useFolderDragging } from "./ProjectFolder";
import { ProjectDragPreviewView } from "@shigomori/ui/views/sidebar/ProjectDragPreviewView.tsx";
import type { SidebarViewModel } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import {
  ForestSlotView,
  InboxCreateRowView,
  PinnedRowView,
  SidebarAsideView,
  SidebarEmptyStateView,
  SidebarScrollerView,
  ViewPaneView,
} from "@shigomori/ui/views/sidebar/SidebarFrameView.tsx";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarToolbar } from "./SidebarToolbar";
import { AddProjectButton } from "./AddProjectButton";
import { useWorktreeSorts } from "@/hooks/sharedSettings/useWorktreeSort";
import { SidebarList } from "./SidebarList";
import { RowContent } from "./RowContent";
import type { RowHandlers } from "./VirtualRow";
import { SidebarTakeoverSlot, useSidebarTakenOver } from "./SidebarTakeover";
import { useForestFolds } from "./useForestFolds";

// The app sidebar, one for both shells: the brand header, the forest
// (or, while a page with a list of its own is open, that list:
// SidebarTakeover), and the footer. The forest is this machine's
// project tree with every peer's forest merged in, in either of its
// two views. A hostless client (the web shell) has no projects of its
// own, so its forest is the peers' alone, through the very same
// component, builders and list, so a peer's worktree row looks the
// same wherever it is drawn and the inbox files it beside a local one.
// The phone layout draws it as a page (ForestPage) and drops the
// footer, whose cluster the tab bar carries there (the two views
// included, each as a tab of its own), so the page pins the view
// instead of reading the preference.
export function Sidebar({
  footer = true,
  view,
}: {
  footer?: boolean;
  view?: SidebarView;
}) {
  const [arrangeMode, setArrangeMode] = useState(false);
  // While a page holds the sidebar (Settings, the diff and files pages)
  // the tree steps aside for its list and comes back when the page
  // goes. The footer goes with it, since none of its actions belong to
  // the page.
  const takenOver = useSidebarTakenOver();
  // Whether a page has held the sidebar yet, so the tree and the footer
  // arrive back from it but not on the first paint.
  const [handedOver, setHandedOver] = useState(false);
  if (takenOver && !handedOver) setHandedOver(true);

  return (
    <SidebarAsideView>
      <SidebarHeader />
      <ForestSlotView takenOver={takenOver} handedOver={handedOver}>
        <Forest
          arrangeMode={arrangeMode}
          onArrange={() => setArrangeMode(true)}
          pinnedView={view}
        />
        {footer && !takenOver && (
          <SidebarFooter
            arrangeMode={arrangeMode}
            onToggleArrange={() => setArrangeMode((v) => !v)}
          />
        )}
      </ForestSlotView>
      <SidebarTakeoverSlot />
    </SidebarAsideView>
  );
}

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- state fields are fully orthogonal UI concerns
function Forest({
  arrangeMode,
  onArrange,
  pinnedView,
}: {
  arrangeMode: boolean;
  onArrange: () => void;
  // Pins the view (a phone tab). Absent, the saved preference decides.
  pinnedView: SidebarView | undefined;
}) {
  const hasLocalHost = useHasLocalHost();
  // A hostless client reaches its forest only through the account:
  // signed out there is nothing to list. A machine with projects of
  // its own lists them whatever the account says.
  const { data: status } = useAccountStatus();
  const signedIn = hasLocalHost || status?.signedIn === true;
  const preferredView = useSidebarView();
  const inbox = (pinnedView ?? preferredView) === "inbox";
  // The inbox's extra facts are asked for only while it shows. The
  // New worktree menu keeps offering every machine whatever the filter
  // narrows: creating is not browsing.
  const {
    projects,
    loading,
    sortMode,
    groupByOwner,
    items,
    deviceFilter,
    devicesFailed,
    failedListings,
    order,
    mirrors,
    deviceBadges,
    hiddenPrefixes,
    allowAgentWorking,
    groupedPrefixes,
    filter,
    activeFilter,
  } = useForestSources({ arrangeMode, inboxFacts: inbox });
  const markAgentsWaiting = useClientFlag("markAgentsWaiting");
  const viewSettled = useSidebarViewSettled() || pinnedView !== undefined;
  const reorderProjects = useReorderProjects();
  // Off arranging, the drag files projects into folders.
  const filing = useFolderDragging();
  const folds = useForestFolds();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Stepped aside for a page's list (SidebarTakeover).
  const takenOver = useSidebarTakenOver();
  // The Tab flip only means something where the preference is what
  // shows. A pinned view has its tab bar.
  useSidebarViewHotkey(!arrangeMode && !takenOver && pinnedView === undefined);

  // SidebarList's, kept here so a takeover's unmount doesn't reset it.
  const foldsOpenedForRef = useRef<string | null>(null);

  // The tree shows the list of projects or one project on its own, and
  // goes into the project of the page on screen (openProject.ts).
  // Inline, it shows every project's worktrees under it instead, each
  // project folding in place.
  const { openKey, onScreenKey } = useOpenProject(items);
  const inline = useClientFlag("inlineWorktrees");
  const worktreeSort = useWorktreeSorts();
  // The level last asked for here, by picking a project or going back,
  // as opposed to one the tree reached by following the page: only the
  // first is a move made in the sidebar, for the list to play.
  const [askedLevel, setAskedLevel] = useState<string | null>();
  const goTo = (groupKey: string | null) => {
    setAskedLevel(groupKey);
    setOpenProject(groupKey);
  };
  const view: SidebarViewModel = inbox
    ? buildInboxRows({
        items,
        deviceFilter,
        mirrors,
        deviceBadges,
        openShelves: folds.inboxShelvesOpen,
        hiddenPrefixes,
        groupedPrefixes,
        shutGroups: folds.shutInboxGroups,
        allowAgentWorking,
        pinWaiting: markAgentsWaiting,
      })
    : buildSidebarRows({
        items,
        deviceFilter,
        openKey,
        inline: inline ? { collapsed: folds.collapsed } : null,
        worktreeSort,
        order,
        openShelves: folds.groupShelvesOpen,
        hiddenPrefixes,
        allowAgentWorking,
        byPrefix: {
          prefixes: groupedPrefixes,
          shut: folds.worktreeGroupShut,
        },
        arrangeMode,
        byOwner: groupByOwner ? { shut: folds.shutOwners } : null,
        shutFolders: folds.shutFolders,
        mirrors,
        deviceBadges,
      });
  const { rows, pinned, level } = view;
  // A pinned view has its tab bar, and a worktree's page replaces it.
  const pageInbox = inbox && pinnedView === undefined;
  useLeaveInboxForPage({
    inbox: pageInbox,
    settled: viewSettled,
    leftOut: view.leftOut,
  });
  // For leaving a page (a delete) to land in this list.
  useShareInboxOrder(rows, pageInbox);
  const inProject = typeof level === "string";
  // Failed listings, local or remote, surface here whether or not the
  // filter shows their rows. Without it a peer's project would
  // silently vanish from the tree, and a narrowed forest must not also
  // mute a failure behind it.
  useFanOutErrorToast(failedListings);
  useUnreachedDevicesToast(devicesFailed);

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    // Reorder writes the stored (manual) order, so it must only run while the
    // displayed order is the stored order. Any other sort means the dragged
    // indices wouldn't line up with `projects`, so bail rather than corrupt.
    if (sortMode !== "manual") return;
    if (!over || active.id === over.id) return;
    const draggedId = String(active.id);
    const targetId = String(over.id);
    const oldIndex = projects.findIndex((p) => p.id === draggedId);
    const newIndex = projects.findIndex((p) => p.id === targetId);
    if (oldIndex < 0 || newIndex < 0) return;
    const position: "before" | "after" =
      oldIndex < newIndex ? "after" : "before";
    reorderProjects.mutate({ draggedId, targetId, position });
  };

  const activeProject = activeId
    ? (projects.find((p) => p.id === activeId) ?? null)
    : null;

  const emptyMessage = emptyForestMessage({
    loading,
    narrowedTo: activeFilter?.label,
    empty: rows.length === 0 && pinned === undefined,
    noProjects: projects.length === 0,
    viewMessage: view.emptyMessage,
    failed: failedListings > 0,
    hasLocalHost,
  });

  // The list unmounts while a page holds the sidebar, rather than
  // hiding: a hidden virtualizer would measure its rows at zero. The
  // queries above stay subscribed, so the way back costs no refetch.
  if (takenOver) return null;
  if (!signedIn) {
    // The phone layout lands a hostless client here (the inbox tab),
    // where the way in is the Devices page, so say so rather than
    // leaving a sentence with nothing to press.
    return (
      <SidebarEmptyStateView message="Sign in to reach this account's devices.">
        <Link
          to="/account"
          className="text-primary underline-offset-2 hover:underline"
        >
          Open Devices
        </Link>
      </SidebarEmptyStateView>
    );
  }

  const handlers: RowHandlers = {
    onToggle: inline ? folds.toggleCollapsed : goTo,
    ...folds.toggles,
    currentGroupKey: onScreenKey,
    arrangeMode,
  };
  // Over the scroller, so it stays put as the rows scroll. It has no
  // hover to track: the open project's title wears its actions at rest.
  // The gap under it keeps the rows scrolling up from being cut off
  // flush against the name.
  const pinnedRow = pinned && (
    <PinnedRowView kind={pinned.kind}>
      <RowContent row={pinned} {...handlers} isHovered={false} />
    </PinnedRowView>
  );
  const scroller = (
    <SidebarScrollerView scrollerRef={scrollerRef}>
      <SidebarList
        rows={rows}
        revealKey={view.revealKey}
        openFold={folds.openFold}
        foldsOpenedForRef={foldsOpenedForRef}
        scrollerRef={scrollerRef}
        // Not while the forest is still listing: the level it settles on
        // is then where it starts, not a move from the list.
        level={loading ? undefined : level}
        asked={askedLevel === level}
        handlers={handlers}
      />
      <SidebarEmptyStateView message={emptyMessage} />
    </SidebarScrollerView>
  );

  return (
    <>
      {/* The device filter comes first, above each view's own controls:
          which machine is showing frames everything under it. Both
          views, one pick. */}
      {!arrangeMode && <DeviceFilterBar {...filter} />}
      <ViewPaneView inbox={inbox} settled={viewSettled}>
        {/* Each view puts what it actually needs above its list. The inbox
            has no project headers to hang a + off, so creating lives here.
            The tree instead gets the controls that only apply to it: the
            way back out of a project and sorting its worktrees, or, on
            the list, sorting this machine's own projects, which a
            hostless client's tree skips.
            Both end in add project. Arranging takes over the whole
            sidebar, so neither shows. */}
        {arrangeMode ? null : inbox ? (
          <InboxCreateRowView
            button={
              <NewWorktreeButton
                items={items}
                order={order}
                byOwner={groupByOwner}
              />
            }
            addProject={<AddProjectButton outline />}
          />
        ) : (
          <SidebarToolbar
            onArrange={onArrange}
            open={
              inProject
                ? {
                    groupKey: level,
                    sort: worktreeSort(level),
                    onBack: () => goTo(null),
                  }
                : undefined
            }
          />
        )}
        {/* Dragging reorders projects, or files them into folders,
            which the inbox doesn't show, so it doesn't mount the DnD
            context at all. The context holds the pinned header too,
            since every project row is a sortable. */}
        {inbox ? (
          scroller
        ) : (
          <DndContext
            sensors={filing.sensors}
            {...(arrangeMode
              ? {
                  onDragStart: handleDragStart,
                  onDragEnd: handleDragEnd,
                  onDragCancel: () => setActiveId(null),
                }
              : filing.handlers)}
          >
            <SortableContext
              items={items.flatMap((item) =>
                item.device.isThisDevice ? [item.project.id] : [],
              )}
              strategy={verticalListSortingStrategy}
            >
              {pinnedRow}
              {scroller}
            </SortableContext>
            {arrangeMode ? (
              <DragOverlay>
                {activeProject ? (
                  <ProjectDragPreviewView project={activeProject} />
                ) : null}
              </DragOverlay>
            ) : (
              filing.overlay
            )}
          </DndContext>
        )}
      </ViewPaneView>
    </>
  );
}

// "Nothing configured" and "configured but nothing to show" are
// different answers, and neither should flash while its list is still
// resolving: `loading` covers the peers too, since with zero local
// projects the rows can still be about to arrive from a peer, and a
// slow device hub must not read as "no projects". A forest narrowed to
// one machine with nothing in it says which machine it looked at,
// since the rows it hides are the obvious thing to go looking for. A
// failed listing has its toast, so the view says nothing over it.
function emptyForestMessage({
  loading,
  narrowedTo,
  empty,
  noProjects,
  viewMessage,
  failed,
  hasLocalHost,
}: {
  loading: boolean;
  // The device filter's pick, by label. Undefined for All.
  narrowedTo: string | undefined;
  empty: boolean;
  noProjects: boolean;
  viewMessage: string | null;
  failed: boolean;
  hasLocalHost: boolean;
}): string | null {
  if (loading) return null;
  if (narrowedTo !== undefined && empty)
    return `No worktrees on ${narrowedTo}.`;
  if (noProjects && empty) {
    return hasLocalHost
      ? "No projects yet."
      : "No reachable devices with projects yet. Open the Devices page to see this account's machines.";
  }
  return failed ? null : viewMessage;
}
