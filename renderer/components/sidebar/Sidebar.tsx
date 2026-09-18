import { useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";
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
import {
  useCollapsedProjects,
  useToggleCollapsedProject,
} from "@/hooks/projects/useCollapsedProjects";
import {
  useCollapsedRemoteProjects,
  useToggleCollapsedRemoteProject,
} from "@/hooks/projects/useCollapsedRemoteProjects";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { useAllProjectShigomoriConfigs } from "@/hooks/config/useShigomoriConfig";
import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useProjects, useReorderProjects } from "@/hooks/projects/useProjects";
import { useProjectSort } from "@/hooks/projects/useProjectSort";
import {
  useSidebarView,
  useSidebarViewHotkey,
} from "@/hooks/projects/useSidebarView";
import { useMirrorLinks } from "@/hooks/remote/useMirrors";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingsSidebarNav } from "@/components/settings/SettingsSidebarNav";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import { useFanOutErrorToast } from "./useFanOutErrorToast";
import {
  buildSidebarRows,
  remoteGroupId,
  remoteGroupKeyOf,
} from "./buildSidebarRows";
import { useDeviceBadges } from "./DeviceBadge";
import { useDeviceFilter } from "./deviceFilter";
import { DeviceFilterBar } from "./DeviceFilterBar";
import { buildInboxRows } from "./inbox/buildInboxRows";
import { NewWorktreeButton } from "./inbox/NewWorktreeButton";
import { ProjectDragPreview } from "./ProjectDragPreview";
import type { InboxShelf, SidebarViewModel } from "./sidebarRow";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarToolbar } from "./SidebarToolbar";
import { TidyButton } from "./TidyButton";
import { sortProjects } from "./sortProjects";
import { SidebarList } from "./SidebarList";
import { withToggled } from "@/lib/toggleSet";

// The app sidebar, one for both shells: the brand header, the forest
// (or, while Settings is open, the page's section list), and the
// footer. The forest is this machine's project tree with every peer's
// forest merged in, in either of its two views. A hostless client (the
// web shell) has no projects of its own, so its forest is the peers'
// alone -- through the very same component, builders and list, so a
// peer's worktree row looks the same wherever it is drawn and the
// inbox files it beside a local one. The phone layout draws it as a
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
  // While Settings is open the sidebar is its section list: the tree
  // steps aside (header and footer stay) and comes back on the next
  // route. The tree's queries never unmount, so the swap costs nothing.
  const onSettings = useLocation({
    select: (location) => location.pathname === "/settings",
  });

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
      <Forest
        settingsOpen={onSettings}
        arrangeMode={arrangeMode}
        onArrange={() => setArrangeMode(true)}
        pinnedView={view}
      />
      {footer && (
        <SidebarFooter
          // Arranging is a tree mode. While Settings holds the sidebar the
          // footer shows its normal actions, and the mode resumes with the
          // tree.
          arrangeMode={arrangeMode && !onSettings}
          onToggleArrange={() => setArrangeMode((v) => !v)}
        />
      )}
    </aside>
  );
}

// The section list Settings puts in the tree's place. Rendered by the
// forest rather than the frame so its hooks (and the queries behind
// them) stay mounted across the swap.
function SettingsPane() {
  return (
    <div className="min-h-0 flex-1">
      <ScrollArea className="size-full">
        <SettingsSidebarNav />
      </ScrollArea>
    </div>
  );
}

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- state fields are fully orthogonal UI concerns
function Forest({
  settingsOpen,
  arrangeMode,
  onArrange,
  pinnedView,
}: {
  settingsOpen: boolean;
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
  const { data: projects = [], isLoading } = useProjects();
  const { data: sortMode = "manual" } = useProjectSort();
  const preferredView = useSidebarView();
  const inbox = (pinnedView ?? preferredView) === "inbox";
  const reorderProjects = useReorderProjects();
  // Absence == expanded, so new projects default open. Persisted in
  // state.json (like the sort preference) so a relaunch keeps the tree
  // the way the user pruned it; the remove handler prunes deleted ids.
  // A project only peers hold folds the same way, its fold kept by
  // this window since no host here has the project.
  const { data: collapsedIds = [] } = useCollapsedProjects();
  const toggleCollapsed = useToggleCollapsedProject();
  const collapsedRemoteKeys = useCollapsedRemoteProjects();
  const toggleCollapsedRemote = useToggleCollapsedRemoteProject();
  // One fold per repo: narrowed to a peer, a repo this machine also
  // holds is drawn as that peer's group, and its fold is still the
  // local project's, read and written under the local id.
  const localIdByIdentity = new Map<string, string>();
  for (const project of projects) {
    if (project.identity != null && project.pathExists !== false) {
      localIdByIdentity.set(project.identity, project.id);
    }
  }
  const collapsed = new Set(collapsedIds);
  for (const [identity, id] of localIdByIdentity) {
    if (collapsed.has(id)) collapsed.add(remoteGroupId(identity));
  }
  for (const key of collapsedRemoteKeys) {
    if (!localIdByIdentity.has(key)) collapsed.add(remoteGroupId(key));
  }
  // Per-project "Show shelved" reveal. Transient on purpose, since the
  // whole point of shelving is to keep the noise down on a fresh window.
  const [shelvedExpanded, setShelvedExpanded] = useState<Set<string>>(
    () => new Set(),
  );
  // Inbox shelves, same transient-by-design reasoning as the per-project
  // reveal above: both start folded on every launch.
  const [openShelves, setOpenShelves] = useState<Set<InboxShelf>>(
    () => new Set(),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  // The Tab flip only means something where the preference is what
  // shows. A pinned view has its tab bar.
  useSidebarViewHotkey(
    !arrangeMode && !settingsOpen && pinnedView === undefined,
  );

  const toggleExpanded = (groupId: string) => {
    const remoteKey = remoteGroupKeyOf(groupId);
    const localId =
      remoteKey === undefined ? groupId : localIdByIdentity.get(remoteKey);
    if (localId !== undefined) toggleCollapsed.mutate(localId);
    else if (remoteKey !== undefined) toggleCollapsedRemote.mutate(remoteKey);
  };

  const toggleShelved = (projectId: string) => {
    setShelvedExpanded(withToggled(projectId));
  };

  const toggleShelf = (shelf: InboxShelf) => {
    setOpenShelves(withToggled(shelf));
  };

  // Display order only. Drag-reorder still operates on the stored order
  // (`projects`), which is safe because dragging is gated to arrange mode and
  // arrange mode is only reachable via the manual sort, where the orders match.
  const orderedProjects = sortProjects(projects, sortMode);

  // Subscribed here rather than inside the row builders so the two views
  // share one set of observers. Toggling the view then costs nothing: the
  // builders are plain functions over these results, and the queries
  // (which re-probe git for every project on mount) never unmount.
  const worktreeQueries = useAllProjectWorktrees(orderedProjects);
  const pullRequestQueries = useAllProjectPullRequests(orderedProjects);
  // Peers' forests, merged into both views beside the local rows. The
  // inbox's extra facts are asked for only while it shows.
  const { items: remoteItems, loading: remoteLoading } = useRemoteForests({
    refetchOnMount: true,
    inboxFacts: inbox,
  });
  const configQueries = useAllProjectShigomoriConfigs(orderedProjects);
  // This device's mirrored pairs, so a pair reads as one row.
  const mirrors = useMirrorLinks();
  // Off the registry, not the rows: a local row mirrored with a peer
  // the filter hides keeps naming it.
  const deviceBadges = useDeviceBadges();
  // The device filter narrows what the builders are handed rather than
  // what they do: one machine's rows only, the local ones or one
  // peer's. The queries above stay subscribed either way, so a pick
  // costs no refetch. Arranging is about this machine's project order
  // and ignores the filter (the bar hides with the rest of the chrome).
  // Creating is not browsing: the New worktree menu keeps offering
  // every machine.
  const filter = useDeviceFilter();
  const activeFilter = arrangeMode ? null : filter.selected;
  const showLocal =
    activeFilter === null || activeFilter.deviceId === localDeviceId;
  // Hidden means empty, for every local input at once: the query
  // arrays too, since the builders count loading and failed listings
  // off them.
  const local = showLocal
    ? {
        projects: orderedProjects,
        worktreeQueries,
        pullRequestQueries,
        configQueries,
      }
    : {
        projects: [],
        worktreeQueries: [],
        pullRequestQueries: [],
        configQueries: [],
      };
  const shownRemote =
    activeFilter === null
      ? remoteItems
      : remoteItems.filter((item) => item.deviceId === activeFilter.deviceId);
  const view: SidebarViewModel = inbox
    ? buildInboxRows({
        ...local,
        remote: shownRemote,
        mirrors,
        deviceBadges,
        openShelves,
      })
    : buildSidebarRows({
        projects: local.projects,
        worktreeQueries: local.worktreeQueries,
        collapsed,
        sortMode,
        shelvedExpanded,
        arrangeMode,
        remote: shownRemote,
        mirrors,
        deviceBadges,
      });
  const { rows } = view;
  // Failed listings, local or remote, surface here whether or not the
  // filter shows their rows -- without it a peer's project would
  // silently vanish from the tree, and a narrowed forest must not also
  // mute a failure behind it.
  useFanOutErrorToast(
    worktreeQueries.filter((q) => q.error).length +
      remoteItems.filter((item) => item.worktreesError).length,
  );

  const viewportRef = useRef<HTMLDivElement | null>(null);

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
    loading: isLoading || remoteLoading,
    narrowedTo: activeFilter?.label,
    empty: rows.length === 0,
    noProjects: projects.length === 0,
    viewMessage: view.emptyMessage,
  });

  if (settingsOpen) return <SettingsPane />;
  if (!signedIn) {
    return (
      <SidebarEmptyState message="Sign in to reach this account's devices." />
    );
  }

  const list = (
    <SidebarList
      rows={rows}
      revealKey={view.revealKey}
      viewportRef={viewportRef}
      handlers={{
        onToggle: toggleExpanded,
        onToggleShelved: toggleShelved,
        onToggleShelf: toggleShelf,
        arrangeMode,
      }}
    />
  );

  return (
    <>
      {/* Each view puts what it actually needs above its list. The inbox
          has no project headers to hang a + off, so creating lives here;
          the tree instead gets the controls that only apply to it --
          which are all about this machine's own projects, so a hostless
          client's tree has nothing to show there. Arranging takes over
          the whole sidebar, so neither shows. */}
      {arrangeMode ? null : (
        <>
          {inbox ? (
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
              {/* The tidy page has no other way in, so it can't live
                  only in the tree's toolbar. It spans this machine's
                  projects, so a hostless client has none to tidy. */}
              {hasLocalHost && <TidyButton />}
            </div>
          ) : hasLocalHost ? (
            <SidebarToolbar onArrange={onArrange} />
          ) : null}
          {/* The device filter sits under each view's own controls,
              right above the list it narrows. Both views, one pick. */}
          <DeviceFilterBar {...filter} />
        </>
      )}
      <div className="min-h-0 flex-1">
        <ScrollArea className="size-full" viewportRef={viewportRef}>
          {/* Dragging reorders projects, which the inbox doesn't show, so
              it doesn't mount the DnD context at all. */}
          {inbox ? (
            list
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
                {list}
              </SortableContext>
              <DragOverlay>
                {activeProject ? (
                  <ProjectDragPreview project={activeProject} />
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
          <SidebarEmptyState message={emptyMessage} />
        </ScrollArea>
      </div>
    </>
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

function SidebarEmptyState({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}
