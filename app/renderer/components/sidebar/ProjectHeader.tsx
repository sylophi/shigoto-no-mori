import { AlertTriangle, ChevronRight } from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import type { Project } from "@shared/schemas";
import { ProjectIcon } from "@/components/shared/ProjectIcon";

interface ProjectHeaderProps {
  project: Project;
  // Whose icon to show when it isn't this scope's own `project`: a
  // project only peers hold reads it off one of them.
  iconFrom?: { projectId: string; deviceId: string };
  // The merged tree's device badge cluster, rendered after the name on
  // the healthy branch only (arrange and missing rows stay quiet).
  badges?: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  missing?: boolean;
  listeners?: DraggableSyntheticListeners;
  onContextMenu?: (event: React.MouseEvent) => void;
  arrangeMode?: boolean;
  // False for a row arrange mode renders but won't let you drag (a
  // terrier project, whose order isn't ours to store).
  reorderable?: boolean;
}

const baseClass =
  "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium";

// Header row shared by the healthy and missing-project branches. The
// project name is `truncate`d, with a Tooltip that only opens when the
// text actually overflows. `useIsTruncated` suppresses redundant
// tooltips on names that already fit.
export function ProjectHeader({
  project,
  iconFrom,
  badges,
  expanded,
  onToggle,
  missing,
  listeners,
  onContextMenu,
  arrangeMode,
  reorderable = true,
}: ProjectHeaderProps) {
  // Keyed on what swaps or refills the name span, which a ResizeObserver
  // on the old span would miss.
  const [nameRef, isTruncated] = useIsTruncated<HTMLSpanElement>(
    `${arrangeMode}:${missing}:${project.name}`,
  );
  const icon = (
    <ProjectIcon
      projectId={iconFrom?.projectId ?? project.id}
      deviceId={iconFrom?.deviceId}
    />
  );
  const trigger = arrangeMode ? (
    <div
      {...listeners}
      onContextMenu={onContextMenu}
      className={cn(
        baseClass,
        "text-muted-foreground transition-colors",
        reorderable
          ? "cursor-grab hover:bg-accent hover:text-foreground active:cursor-grabbing"
          : "cursor-not-allowed opacity-50",
        missing && "text-muted-foreground/60 hover:text-muted-foreground",
      )}
    >
      {missing ? (
        <AlertTriangle className="size-3 shrink-0 text-destructive/70" />
      ) : (
        icon
      )}
      <span
        ref={nameRef}
        className={cn(
          "min-w-0 truncate",
          missing && "line-through decoration-1",
        )}
      >
        {project.name}
      </span>
    </div>
  ) : missing ? (
    <div
      onContextMenu={onContextMenu}
      className={cn(baseClass, "text-muted-foreground/60")}
    >
      <AlertTriangle className="size-3 shrink-0 text-destructive/70" />
      <span
        ref={nameRef}
        className="min-w-0 truncate line-through decoration-1"
      >
        {project.name}
      </span>
      <span className="shrink-0 text-3xs font-medium tracking-normal text-muted-foreground/60 normal-case">
        missing
      </span>
    </div>
  ) : (
    <button
      type="button"
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className={cn(
        baseClass,
        "text-muted-foreground transition-colors hover:text-foreground",
      )}
    >
      <ChevronRight
        className={cn(
          "size-3 shrink-0 transition-transform",
          expanded && "rotate-90",
        )}
      />
      {icon}
      <span ref={nameRef} className="min-w-0 truncate">
        {project.name}
      </span>
      {badges}
    </button>
  );

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger render={trigger} />
      <TooltipContent>{project.name}</TooltipContent>
    </Tooltip>
  );
}
