import { useEffect, useRef, useState } from "react";
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
import { useAllProjectShigomoriConfigs } from "@/hooks/config/useShigomoriConfig";
import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useProjects, useReorderProjects } from "@/hooks/projects/useProjects";
import { useProjectSort } from "@/hooks/projects/useProjectSort";
import {
  useSidebarView,
  useSidebarViewHotkey,
} from "@/hooks/projects/useSidebarView";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import { buildSidebarRows } from "./buildSidebarRows";
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

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- state fields are fully orthogonal UI concerns
export function Sidebar() {
  const { data: projects = [], isLoading } = useProjects();
  const { data: sortMode = "manual" } = useProjectSort();
  const inbox = useSidebarView() === "inbox";
  const reorderProjects = useReorderProjects();
  // Absence == expanded, so new projects default open. Persisted in
  // state.json (like the sort preference) so a relaunch keeps the tree
  // the way the user pruned it; the remove handler prunes deleted ids.
  const { data: collapsedIds = [] } = useCollapsedProjects();
  const toggleCollapsed = useToggleCollapsedProject();
  const collapsed = new Set(collapsedIds);
  // Per-project "Show shelved" reveal. Transient on purpose -- the
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
  const [arrangeMode, setArrangeMode] = useState(false);
  useSidebarViewHotkey(!arrangeMode);

  const toggleExpanded = (projectId: string) => {
    toggleCollapsed.mutate(projectId);
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
  // builders are plain functions over these results, and the queries --
  // which re-probe git for every project on mount -- never unmount.
  const worktreeQueries = useAllProjectWorktrees(orderedProjects);
  const pullRequestQueries = useAllProjectPullRequests(orderedProjects);
  const configQueries = useAllProjectShigomoriConfigs(orderedProjects);
  const view: SidebarViewModel = inbox
    ? buildInboxRows({
        projects: orderedProjects,
        worktreeQueries,
        pullRequestQueries,
        configQueries,
        openShelves,
      })
    : buildSidebarRows({
        projects: orderedProjects,
        worktreeQueries,
        collapsed,
        shelvedExpanded,
        arrangeMode,
      });
  const { rows, failedCount } = view;

  // The per-project query is silent so the all-projects launcher fan-out
  // doesn't spam toasts; here we coalesce the same observations into one.
  useEffect(() => {
    const id = "worktrees-fanout-error";
    if (failedCount === 0) {
      toast.dismiss(id);
      return;
    }
    toast.error(
      `Couldn't load worktrees for ${failedCount} ${failedCount === 1 ? "project" : "projects"}`,
      { id },
    );
  }, [failedCount]);

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
    // indices wouldn't line up with `projects` -- bail rather than corrupt.
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

  // "Nothing configured" and "configured but nothing to show" are
  // different answers, and neither should flash while its list is still
  // resolving.
  const emptyMessage = isLoading
    ? null
    : projects.length === 0
      ? "No projects yet."
      : view.emptyMessage;

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
      {/* Each view puts what it actually needs above its list. The inbox
          has no project headers to hang a + off, so creating lives here;
          the tree instead gets the controls that only apply to it.
          Arranging takes over the whole sidebar, so neither shows. */}
      {arrangeMode ? null : inbox ? (
        // px-2 like the rows below it, which is where v1 wants it.
        // doubutsu pulls it in to its banner card, hence the slot.
        <div
          data-slot="sidebar-inbox-create"
          className="flex items-center gap-1 px-2 pb-1.5"
        >
          <div className="min-w-0 flex-1">
            <NewWorktreeButton projects={orderedProjects} />
          </div>
          {/* The tidy page has no other way in, so it can't live only in
              the tree's toolbar. */}
          <TidyButton />
        </div>
      ) : (
        <SidebarToolbar onArrange={() => setArrangeMode(true)} />
      )}
      <div className="min-h-0 flex-1">
        <ScrollArea className="size-full" viewportRef={viewportRef}>
          {/* Dragging reorders projects, which the inbox doesn't show --
              so it doesn't mount the DnD context at all. */}
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
      <SidebarFooter
        arrangeMode={arrangeMode}
        onToggleArrange={() => setArrangeMode((v) => !v)}
      />
    </aside>
  );
}

function SidebarEmptyState({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}
