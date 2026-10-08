import { useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { SidebarView } from "@shared/schemas";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { useReorderProjects } from "@/hooks/projects/useProjects";
import {
  useSidebarView,
  useSidebarViewHotkey,
  useSidebarViewSettled,
} from "@/hooks/projects/useSidebarView";
import { hasLocalHost } from "@/lib/localHost";
import { useFanOutErrorToast } from "./useFanOutErrorToast";
import {
  buildSidebarRows,
  type GroupIdSet,
  projectGroupKey,
  remoteGroupKeyOf,
} from "./buildSidebarRows";
import { useForestSources } from "./forestSources";
import { DeviceFilterBar } from "./DeviceFilterBar";
import { buildInboxRows } from "./inbox/buildInboxRows";
import { useShareInboxOrder } from "./inbox/inboxOrder";
import { NewWorktreeButton } from "./inbox/NewWorktreeButton";
import { useLeaveInboxForPage } from "./inbox/useLeaveInboxForPage";
import { setOpenProject, useOpenProject } from "./openProject";
import { ProjectDragPreview } from "./ProjectDragPreview";
import {
  ROW_LAYOUT,
  type GroupShelf,
  type InboxShelf,
  type SidebarRow,
  type SidebarViewModel,
} from "./sidebarRow";
import { ARRIVE_FROM } from "./sidebarChrome";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarToolbar } from "./SidebarToolbar";
import { AddProjectButton } from "./AddProjectButton";
import { useWorktreeSort } from "@/hooks/sharedSettings/useWorktreeSort";
import { SidebarList } from "./SidebarList";
import { RowContent } from "./RowContent";
import type { RowHandlers } from "./VirtualRow";
import { SidebarTakeoverSlot, useSidebarTakenOver } from "./SidebarTakeover";
import { withMember, withToggled } from "@/lib/toggleSet";
import { cn } from "@/lib/utils";

// The app sidebar, one for both shells: the brand header, the forest
// (or, while a page with a list of its own is open, that list:
// SidebarTakeover), and the footer. The forest is this machine's
// project tree with every peer's forest merged in, in either of its
// two views. A hostless client (the web shell) has no projects of its
// own, so its forest is the peers' alone -- through the very same
// component, builders and list, so a peer's worktree row looks the
// same wherever it is drawn and the inbox files it beside a local one. The phone layout draws it as a
// page (ForestPage) and drops the footer, whose cluster the tab bar
// carries there -- the two views included, each as a tab of its own,
// so the page pins the view instead of reading the preference.
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
    // Both themes are fully transparent so the BrowserWindow vibrancy
    // material shows through. A heavy white wash in light mode washes
    // out the chroma, so we let the "sidebar" material do its job on
    // its own. The `data-sidebar` attribute scopes the token overrides
    // in index.css to this surface only.
    <aside
      data-sidebar
      data-doubutsu-zone="sidebar"
      className="flex h-full flex-col"
    >
      <SidebarHeader />
      {/* Hidden rather than unmounted while a page holds the sidebar,
          so the forest keeps its place (the open project, the shelves)
          for the way back. Showing it again replays the arrival. */}
      <div
        className={
          takenOver
            ? "hidden"
            : cn("flex min-h-0 flex-1 flex-col", handedOver && ARRIVE_FROM.left)
        }
      >
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
      </div>
      <SidebarTakeoverSlot />
    </aside>
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
    orderedProjects,
    loading,
    sortMode,
    groupByOwner,
    worktreeQueries,
    remoteItems,
    order,
    local,
    shownRemote,
    mirrors,
    deviceBadges,
    hiddenPrefixes,
    allowAgentWorking,
    groupedPrefixes,
    filter,
    activeFilter,
  } = useForestSources({ arrangeMode, inboxFacts: inbox });
  const viewSettled = useSidebarViewSettled() || pinnedView !== undefined;
  const reorderProjects = useReorderProjects();
  // The open project and the shelf reveals are kept by group key
  // (projectGroupKey), one per repo: narrowed to a peer, a repo this
  // machine also holds is drawn as that peer's group, and it still
  // reads and writes the one key the local project's group goes by.
  const localGroupKeys = new Map(
    projects.map((project) => [
      project.id,
      projectGroupKey(project, undefined),
    ]),
  );
  const groupKeyOf = (groupId: string): string =>
    remoteGroupKeyOf(groupId) ?? localGroupKeys.get(groupId) ?? groupId;
  const byGroupKey = (keys: ReadonlySet<string>): GroupIdSet => ({
    has: (groupId) => keys.has(groupKeyOf(groupId)),
  });
  // Per-group "Show agent working", "Show shelved" and "Show hidden"
  // reveals. Transient on purpose, since the whole point of them is to
  // keep the noise down on a fresh window.
  const [shelfOpenKeys, setShelfOpenKeys] = useState<
    Record<GroupShelf, Set<string>>
  >(() => ({ agentWorking: new Set(), shelved: new Set(), hidden: new Set() }));
  const groupShelvesOpen: Record<GroupShelf, GroupIdSet> = {
    agentWorking: byGroupKey(shelfOpenKeys.agentWorking),
    shelved: byGroupKey(shelfOpenKeys.shelved),
    hidden: byGroupKey(shelfOpenKeys.hidden),
  };
  // Inbox shelves, same transient-by-design reasoning as the per-group
  // reveal above: both start folded on every launch.
  const [openShelves, setOpenShelves] = useState<Set<InboxShelf>>(
    () => new Set(),
  );
  // The owners shut on the list of projects split by owner, by owner
  // key (ownerOf). Transient like the shelves: every owner starts open.
  const [shutOwners, setShutOwners] = useState<Set<string>>(() => new Set());
  // The prefix groups shut inside a project, by group key and prefix.
  // Transient too: every group starts open.
  const [shutWorktreeGroups, setShutWorktreeGroups] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const worktreeGroupKey = (groupId: string, prefix: string) =>
    `${groupKeyOf(groupId)}\n${prefix}`;
  const [activeId, setActiveId] = useState<string | null>(null);
  // Stepped aside for a page's list (SidebarTakeover).
  const takenOver = useSidebarTakenOver();
  // The Tab flip only means something where the preference is what
  // shows. A pinned view has its tab bar.
  useSidebarViewHotkey(!arrangeMode && !takenOver && pinnedView === undefined);

  const toggleShelved = (groupId: string, shelf: GroupShelf) => {
    setShelfOpenKeys((prev) => ({
      ...prev,
      [shelf]: withToggled(groupKeyOf(groupId))(prev[shelf]),
    }));
  };

  const toggleShelf = (shelf: InboxShelf) => {
    setOpenShelves(withToggled(shelf));
  };

  // For revealing a worktree behind a shut shelf (SidebarList). Adds
  // rather than toggles, so a second call before the first lands is
  // harmless.
  const openFold = (row: SidebarRow): boolean => {
    if (row.kind === "shelved-toggle" && !row.expanded) {
      const key = groupKeyOf(row.groupId);
      setShelfOpenKeys((prev) => ({
        ...prev,
        [row.shelf]: new Set(prev[row.shelf]).add(key),
      }));
      return true;
    }
    if (row.kind === "worktree-group" && !row.expanded) {
      const key = worktreeGroupKey(row.groupId, row.prefix);
      setShutWorktreeGroups((prev) => withMember(prev, key, false));
      return true;
    }
    if (row.kind === "inbox-shelf" && !row.expanded) {
      setOpenShelves((prev) => new Set(prev).add(row.shelf));
      return true;
    }
    return false;
  };
  // SidebarList's, kept here so a takeover's unmount doesn't reset it.
  const foldsOpenedForRef = useRef<string | null>(null);

  // The tree shows the list of projects or one project on its own, and
  // goes into the project of the page on screen (openProject.ts).
  const { openKey, onScreenKey } = useOpenProject(projects, remoteItems);
  const worktreeSort = useWorktreeSort(openKey);
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
        ...local,
        remote: shownRemote,
        mirrors,
        deviceBadges,
        openShelves,
        hiddenPrefixes,
        allowAgentWorking,
      })
    : buildSidebarRows({
        ...local,
        openKey,
        worktreeSort,
        order,
        openShelves: groupShelvesOpen,
        hiddenPrefixes,
        allowAgentWorking,
        byPrefix: {
          prefixes: groupedPrefixes,
          shut: (groupId, prefix) =>
            shutWorktreeGroups.has(worktreeGroupKey(groupId, prefix)),
        },
        arrangeMode,
        byOwner: groupByOwner ? { shut: shutOwners } : null,
        remote: shownRemote,
        mirrors,
        deviceBadges,
      });
  const { rows, pinned, level } = view;
  // A pinned view has its tab bar, and a worktree's page replaces it.
  const pageInbox = inbox && pinnedView === undefined;
  useLeaveInboxForPage({
    inbox: pageInbox,
    settled: viewSettled,
    shownDevice: activeFilter?.deviceId ?? null,
    leftOut: view.leftOut,
  });
  // For leaving a page (a delete) to land in this list.
  useShareInboxOrder(rows, pageInbox);
  const inProject = typeof level === "string";
  // Failed listings, local or remote, surface here whether or not the
  // filter shows their rows -- without it a peer's project would
  // silently vanish from the tree, and a narrowed forest must not also
  // mute a failure behind it.
  useFanOutErrorToast(
    worktreeQueries.filter((q) => q.error).length +
      remoteItems.filter((item) => item.worktreesError).length,
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // distance: 5 lets a quick click still toggle expand; drag activates
  // only after the pointer moves 5px while held.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

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
      <SidebarEmptyState message="Sign in to reach this account's devices.">
        <Link
          to="/account"
          className="text-primary underline-offset-2 hover:underline"
        >
          Open Devices
        </Link>
      </SidebarEmptyState>
    );
  }

  const handlers: RowHandlers = {
    onToggle: goTo,
    onToggleShelved: toggleShelved,
    onToggleShelf: toggleShelf,
    onToggleOwner: (ownerKey) => setShutOwners(withToggled(ownerKey)),
    onToggleWorktreeGroup: (groupId, prefix) =>
      setShutWorktreeGroups(withToggled(worktreeGroupKey(groupId, prefix))),
    currentGroupKey: onScreenKey,
    arrangeMode,
  };
  // Over the scroller, so it stays put as the rows scroll. It has no
  // hover to track: the open project's title wears its actions at rest.
  // The gap under it keeps the rows scrolling up from being cut off
  // flush against the name.
  const pinnedRow = pinned && (
    <div
      data-slot="sidebar-row"
      className={cn(ROW_LAYOUT[pinned.kind], "pb-1")}
    >
      <RowContent row={pinned} {...handlers} isHovered={false} />
    </div>
  );
  const scroller = (
    <div
      ref={scrollerRef}
      data-slot="sidebar-scroller"
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
    >
      <SidebarList
        rows={rows}
        revealKey={view.revealKey}
        openFold={openFold}
        foldsOpenedForRef={foldsOpenedForRef}
        scrollerRef={scrollerRef}
        // Not while the forest is still listing: the level it settles on
        // is then where it starts, not a move from the list.
        level={loading ? undefined : level}
        asked={askedLevel === level}
        handlers={handlers}
      />
      <SidebarEmptyState message={emptyMessage} />
    </div>
  );

  return (
    <>
      {/* The device filter comes first, above each view's own controls:
          which machine is showing frames everything under it. Both
          views, one pick. */}
      {!arrangeMode && <DeviceFilterBar {...filter} />}
      <ViewPane inbox={inbox} settled={viewSettled}>
        {/* Each view puts what it actually needs above its list. The inbox
            has no project headers to hang a + off, so creating lives here;
            the tree instead gets the controls that only apply to it: the
            way back out of a project and sorting its worktrees, or, on
            the list, sorting this machine's own projects, which a
            hostless client's tree skips.
            Both end in add project. Arranging takes over the whole
            sidebar, so neither shows. */}
        {arrangeMode ? null : inbox ? (
          // px-2 like the rows below it, which is where v1 wants it.
          // doubutsu pulls it in to its banner card, hence the slot.
          <div
            data-slot="sidebar-inbox-create"
            className="flex items-center gap-1 px-2 pb-1.5"
          >
            <div className="min-w-0 flex-1">
              <NewWorktreeButton
                projects={orderedProjects}
                remote={remoteItems}
              />
            </div>
            <AddProjectButton outline />
          </div>
        ) : (
          <SidebarToolbar
            onArrange={onArrange}
            open={
              inProject
                ? {
                    groupKey: level,
                    sort: worktreeSort,
                    onBack: () => goTo(null),
                  }
                : undefined
            }
          />
        )}
        {/* Dragging reorders projects, which the inbox doesn't show, so
            it doesn't mount the DnD context at all. The context holds the
            pinned header too, since every project row is a sortable. */}
        {inbox ? (
          scroller
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={orderedProjects.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {pinnedRow}
              {scroller}
            </SortableContext>
            <DragOverlay>
              {activeProject ? (
                <ProjectDragPreview project={activeProject} />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </ViewPane>
    </>
  );
}

// The view's own part of the forest, below the filter both views
// share. A flip plays across it, the tree being the inbox's right-hand
// neighbour as on the toggle. Only once the view is settled, so the
// saved one replacing the default after the first paint is no flip.
// Tracked here rather than in Forest, whose rows would build twice.
function ViewPane({
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

// "Nothing configured" and "configured but nothing to show" are
// different answers, and neither should flash while its list is still
// resolving: `loading` covers the peers too, since with zero local
// projects the rows can still be about to arrive from a peer, and a
// slow device hub must not read as "no projects". A forest narrowed to
// one machine with nothing in it says which machine it looked at,
// since the rows it hides are the obvious thing to go looking for.
function emptyForestMessage({
  loading,
  narrowedTo,
  empty,
  noProjects,
  viewMessage,
}: {
  loading: boolean;
  // The device filter's pick, by label. Undefined for All.
  narrowedTo: string | undefined;
  empty: boolean;
  noProjects: boolean;
  viewMessage: string | null;
}): string | null {
  if (loading) return null;
  if (narrowedTo !== undefined && empty)
    return `No worktrees on ${narrowedTo}.`;
  if (noProjects && empty) {
    return hasLocalHost
      ? "No projects yet."
      : "No reachable devices with projects yet. Open the Devices page to see this account's machines.";
  }
  return viewMessage;
}

function SidebarEmptyState({
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
