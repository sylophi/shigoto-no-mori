import { useRef, useState } from "react";
import {
  ChevronRight,
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
import { cn } from "@/lib/utils";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useProjects, useReorderProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useAllProjectWorktrees } from "@/hooks/useWorktrees";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { Project, Worktree } from "@shared/schemas";
import { ProjectRow } from "./ProjectRow";
import { WorktreeRow } from "./WorktreeRow";

type SidebarRow =
  | { kind: "project"; key: string; project: Project; expanded: boolean }
  | { kind: "worktree"; key: string; worktree: Worktree }
  | { kind: "worktree-skeleton"; key: string; projectId: string }
  | { kind: "worktree-error"; key: string; projectId: string };

const ROW_SIZE_HINTS: Record<SidebarRow["kind"], number> = {
  project: 28,
  worktree: 40,
  "worktree-skeleton": 36,
  "worktree-error": 24,
};

export function Sidebar() {
  const { data: projects = [], isLoading } = useProjects();
  const reorderProjects = useReorderProjects();
  // Absence == expanded, so new projects default open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);

  const toggleExpanded = (projectId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const worktreeQueries = useAllProjectWorktrees(projects, true);

  const rows: SidebarRow[] = (() => {
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
      for (const worktree of trees) {
        out.push({
          kind: "worktree",
          key: `w:${worktree.id}`,
          worktree,
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
    <aside className="flex h-full flex-col bg-card">
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
                className="relative px-2"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = rows[vi.index];
                  if (!row) return null;
                  return (
                    <div
                      key={row.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className={cn(
                        "absolute top-0 left-0 w-full",
                        row.kind !== "project" && "pl-3",
                      )}
                      style={{ transform: `translateY(${vi.start}px)` }}
                    >
                      <RowContent row={row} onToggle={toggleExpanded} />
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
      <SidebarFooter />
    </aside>
  );
}

function RowContent({
  row,
  onToggle,
}: {
  row: SidebarRow;
  onToggle: (projectId: string) => void;
}) {
  if (row.kind === "project") {
    return (
      <ProjectRow
        project={row.project}
        expanded={row.expanded}
        onToggle={() => onToggle(row.project.id)}
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
  return (
    <div className="px-2 py-1 text-xs text-destructive">
      Failed to list worktrees
    </div>
  );
}

function ProjectDragPreview({ project }: { project: Project }) {
  return (
    <div className="cursor-grabbing rounded-md bg-card shadow-md outline -outline-offset-1 outline-foreground/25">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        <ChevronRight className="size-3 shrink-0 rotate-90" />
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
      style={{ ["-webkit-app-region" as never]: "drag" }}
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
        style={
          showDevStyle
            ? { ["-webkit-app-region" as never]: "no-drag" }
            : undefined
        }
      >
        Shigoto no Mori
      </div>
    </div>
  );
}

function SidebarFooter() {
  const navigate = useNavigate();
  const location = useLocation();
  const { openIn } = useCommandPalette();
  const settingsActive = location.pathname === "/settings";
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      <button
        type="button"
        onClick={() => void navigate({ to: "/settings" })}
        aria-label="Settings"
        aria-current={settingsActive ? "page" : undefined}
        title="Settings"
        className={cn(
          "rounded-md p-1.5 transition-colors hover:bg-accent hover:text-foreground",
          settingsActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground",
        )}
      >
        <SettingsIcon className="size-3.5" />
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
