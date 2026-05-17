import { useState } from "react";
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
import { cn } from "@/lib/utils";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useProjects, useReorderProjects } from "@/hooks/useProjects";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Project } from "@shared/schemas";
import { ProjectGroup } from "./ProjectGroup";

export function Sidebar() {
  const { data: projects = [], isLoading } = useProjects();
  const reorderProjects = useReorderProjects();
  const [activeId, setActiveId] = useState<string | null>(null);

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
        <ScrollArea className="size-full">
          <div className="flex flex-col gap-1 px-2 pt-0">
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
                {projects.map((project) => (
                  <ProjectGroup key={project.id} project={project} />
                ))}
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
          </div>
        </ScrollArea>
      </div>
      <SidebarFooter />
    </aside>
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
  return (
    <div
      className="flex h-[52px] items-center px-3 pl-[92px]"
      // macOS title-bar drag region
      style={{ ["-webkit-app-region" as never]: "drag" }}
    >
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
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
        title="Command palette (⌘T)"
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
