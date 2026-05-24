import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  FolderPlus,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
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
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, dragRegion } from "@/lib/utils";
import { useCommandPalette } from "@/hooks/ui/useCommandPalette";
import { useProjects, useReorderProjects } from "@/hooks/projects/useProjects";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useUpdater } from "@/hooks/system/useUpdater";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/lib/toast";
import type { Project, Worktree } from "@shared/schemas";
import { ProjectRow } from "./ProjectRow";
import { WorktreeRow } from "./WorktreeRow";

type SidebarRow =
  | { kind: "project"; key: string; project: Project; expanded: boolean }
  | { kind: "worktree"; key: string; worktree: Worktree }
  | { kind: "worktree-skeleton"; key: string; projectId: string }
  | { kind: "worktree-error"; key: string; projectId: string }
  | {
      kind: "shelved-toggle";
      key: string;
      projectId: string;
      count: number;
      expanded: boolean;
    };

const ROW_SIZE_HINTS: Record<SidebarRow["kind"], number> = {
  project: 28,
  worktree: 40,
  "worktree-skeleton": 36,
  "worktree-error": 24,
  "shelved-toggle": 24,
};

export function Sidebar() {
  const { data: projects = [], isLoading } = useProjects();
  const reorderProjects = useReorderProjects();
  // Absence == expanded, so new projects default open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Per-project "Show shelved" reveal. Transient on purpose -- the
  // whole point of shelving is to keep the noise down on a fresh window.
  const [shelvedExpanded, setShelvedExpanded] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [arrangeMode, setArrangeMode] = useState(false);
  // Tracks the project whose region the cursor is currently over (header
  // row OR one of its child rows). Lets the ProjectRow keep its action
  // buttons visible while the cursor sits on a worktree below it.
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);

  const toggleExpanded = (projectId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleShelved = (projectId: string) => {
    setShelvedExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const worktreeQueries = useAllProjectWorktrees(projects, true);

  // The per-project query is silent so the all-projects palette fan-out
  // doesn't spam toasts; here we coalesce the same observations into one.
  const failedCount = worktreeQueries.filter((q) => q.error).length;
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

  const rows: SidebarRow[] = arrangeMode
    ? projects.map((project) => ({
        kind: "project",
        key: `p:${project.id}`,
        project,
        expanded: false,
      }))
    : (() => {
        const out: SidebarRow[] = [];
        projects.forEach((project, i) => {
          const expanded = !collapsed.has(project.id);
          out.push({
            kind: "project",
            key: `p:${project.id}`,
            project,
            expanded,
          });
          if (!expanded || project.pathExists === false) return;
          const query = worktreeQueries[i];
          if (!query) return;
          if (query.isLoading) {
            out.push({
              kind: "worktree-skeleton",
              key: `sk:${project.id}`,
              projectId: project.id,
            });
            return;
          }
          if (query.error) {
            out.push({
              kind: "worktree-error",
              key: `err:${project.id}`,
              projectId: project.id,
            });
            return;
          }
          const trees = (query.data ?? []) as Worktree[];
          const visible = trees.filter((w) => !w.shelved);
          const shelved = trees.filter((w) => w.shelved);
          for (const worktree of visible) {
            out.push({
              kind: "worktree",
              key: `w:${worktree.id}`,
              worktree,
            });
          }
          if (shelved.length > 0) {
            const shelfOpen = shelvedExpanded.has(project.id);
            if (shelfOpen) {
              for (const worktree of shelved) {
                out.push({
                  kind: "worktree",
                  key: `w:${worktree.id}`,
                  worktree,
                });
              }
            }
            // Always anchored at the bottom of the project's section:
            // "N shelved" reveals, "Hide shelved" collapses.
            out.push({
              kind: "shelved-toggle",
              key: `shelf:${project.id}`,
              projectId: project.id,
              count: shelved.length,
              expanded: shelfOpen,
            });
          }
        });
        return out;
      })();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => ROW_SIZE_HINTS[rows[index]?.kind ?? "worktree"],
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

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

  return (
    // Both themes are fully transparent so the BrowserWindow vibrancy
    // material shows through. A heavy white wash in light mode washes
    // out the chroma, so we let the macOS "sidebar" material do its job
    // on its own. The `data-sidebar` attribute scopes the token
    // overrides in index.css to this surface only.
    <aside data-sidebar className="flex h-full flex-col">
      <SidebarHeader />
      <div className="min-h-0 flex-1">
        <ScrollArea className="size-full" viewportRef={viewportRef}>
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={projects.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              <div
                className="relative"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = rows[vi.index];
                  if (!row) return null;
                  const rowProjectId = projectIdForRow(row);
                  return (
                    <div
                      key={row.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className={cn(
                        "absolute top-0 left-0 w-full px-2",
                        row.kind !== "project" && "pl-5",
                      )}
                      style={{ transform: `translateY(${vi.start}px)` }}
                      onMouseEnter={() => setHoveredProjectId(rowProjectId)}
                      onMouseLeave={() =>
                        setHoveredProjectId((cur) =>
                          cur === rowProjectId ? null : cur,
                        )
                      }
                    >
                      <RowContent
                        row={row}
                        onToggle={toggleExpanded}
                        onToggleShelved={toggleShelved}
                        arrangeMode={arrangeMode}
                        isHovered={hoveredProjectId === rowProjectId}
                      />
                    </div>
                  );
                })}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeProject ? (
                <ProjectDragPreview project={activeProject} />
              ) : null}
            </DragOverlay>
          </DndContext>
          {!isLoading && projects.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No projects yet.
            </div>
          )}
        </ScrollArea>
      </div>
      <SidebarFooter
        arrangeMode={arrangeMode}
        onToggleArrange={() => setArrangeMode((v) => !v)}
      />
    </aside>
  );
}

function projectIdForRow(row: SidebarRow): string {
  if (row.kind === "project") return row.project.id;
  if (row.kind === "worktree") return row.worktree.projectId;
  return row.projectId;
}

function RowContent({
  row,
  onToggle,
  onToggleShelved,
  arrangeMode,
  isHovered,
}: {
  row: SidebarRow;
  onToggle: (projectId: string) => void;
  onToggleShelved: (projectId: string) => void;
  arrangeMode: boolean;
  isHovered: boolean;
}) {
  if (row.kind === "project") {
    return (
      <ProjectRow
        project={row.project}
        expanded={row.expanded}
        onToggle={() => onToggle(row.project.id)}
        arrangeMode={arrangeMode}
        isHovered={isHovered}
      />
    );
  }
  if (row.kind === "worktree") {
    return <WorktreeRow worktree={row.worktree} />;
  }
  if (row.kind === "worktree-skeleton") {
    return (
      <div className="space-y-1 px-2 py-1.5" aria-label="Loading worktrees">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }
  if (row.kind === "shelved-toggle") {
    return (
      <ShelvedToggleRow
        count={row.count}
        expanded={row.expanded}
        onToggle={() => onToggleShelved(row.projectId)}
      />
    );
  }
  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      Couldn't load worktrees.
    </div>
  );
}

function ShelvedToggleRow({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {expanded ? "Hide shelved" : `${count} shelved`}
    </button>
  );
}

function ProjectDragPreview({ project }: { project: Project }) {
  // Matches the arrange-mode ProjectHeader layout so the preview lines
  // up exactly with the row the cursor grabbed.
  return (
    <div className="py-0.5">
      <div className="flex cursor-grabbing items-center rounded-md bg-card px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase shadow-md outline -outline-offset-1 outline-foreground/25">
        <span className="min-w-0 truncate">{project.name}</span>
      </div>
    </div>
  );
}

function SidebarHeader() {
  const { data: runtime } = useRuntimeInfo();
  const isDev = runtime?.isDev ?? false;
  // One-way peek at prod styling. Reset on unmount (window reload).
  // Once flipped, the markup below is identical to the packaged build.
  const [revealProd, setRevealProd] = useState(false);
  const showDevStyle = isDev && !revealProd;
  return (
    <div
      className="flex h-[52px] items-center px-3 pl-[92px]"
      // macOS title-bar drag region
      style={dragRegion("drag")}
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- internal dev affordance, no keyboard equivalent needed */}
      <div
        className={cn(
          "min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight",
          showDevStyle && "font-mono text-amber-500",
        )}
        onClick={showDevStyle ? () => setRevealProd(true) : undefined}
        // Carve a no-drag hole only while the affordance is active so the
        // click isn't eaten by the title-bar drag region.
        style={showDevStyle ? dragRegion("no-drag") : undefined}
      >
        Shigoto no Mori
      </div>
    </div>
  );
}

function SidebarFooter({
  arrangeMode,
  onToggleArrange,
}: {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { openIn } = useCommandPalette();
  const { state: updaterState } = useUpdater();
  const updateReady = updaterState?.kind === "ready";
  const settingsActive = location.pathname === "/settings";
  if (arrangeMode) {
    return (
      <div className="flex items-center justify-end border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={onToggleArrange}
          className="rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide text-foreground uppercase transition-colors hover:bg-accent"
        >
          Done
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      <button
        type="button"
        onClick={() => void navigate({ to: "/settings" })}
        aria-label={updateReady ? "Settings (update available)" : "Settings"}
        aria-current={settingsActive ? "page" : undefined}
        title={updateReady ? "Settings — update available" : "Settings"}
        className={cn(
          "relative rounded-md p-1.5 transition-colors hover:bg-accent hover:text-foreground",
          settingsActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground",
        )}
      >
        <SettingsIcon className="size-3.5" />
        {updateReady && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 ring-2 ring-card"
          />
        )}
      </button>
      <button
        type="button"
        onClick={onToggleArrange}
        aria-label="Arrange projects"
        title="Arrange projects"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowUpDown className="size-3.5" />
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => openIn("browse")}
        aria-label="Command palette"
        title="Command palette (⌘⇧P)"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => openIn("add-project")}
        aria-label="Add project"
        title="Add project (⌘N)"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderPlus className="size-3.5" />
      </button>
    </div>
  );
}
