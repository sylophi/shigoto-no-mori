import { AlertTriangle, Folder } from "lucide-react";
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
import { TerrierMark } from "./TerrierMark";

interface ProjectHeaderProps {
  project: Project;
  // Whose icon to show when it isn't this scope's own `project`: a
  // project only peers hold reads it off one of them.
  iconFrom?: { projectId: string; deviceId: string };
  // The merged tree's device badge cluster, rendered after the name of
  // the open project only: the list's rows are names alone, since every
  // row wearing them made the list a wall of icons.
  badges?: React.ReactNode;
  // Some checkout in the header's group is terrier-sourced, which puts
  // the paw after the open project's name while Mark terrier projects
  // is on.
  terrier?: boolean;
  // The open project, heading the tree on its own: a title, with
  // nothing left for it to open.
  expanded?: boolean;
  // On the list: the page on screen belongs to this project.
  current?: boolean;
  // Picked off the list.
  onToggle?: () => void;
  missing?: boolean;
  listeners?: DraggableSyntheticListeners;
  onContextMenu?: (event: React.MouseEvent) => void;
  arrangeMode?: boolean;
  // False for a row arrange mode renders but won't let you drag (a
  // peer's project, whose order isn't this machine's to store).
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
  terrier = false,
  expanded,
  current,
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
    `${arrangeMode}:${missing}:${expanded}:${project.name}`,
  );
  // The same lead and name in every branch; only one branch mounts, so
  // the ref lands once.
  const lead = missing ? (
    <AlertTriangle className="size-3 shrink-0 text-destructive/70" />
  ) : (
    // The projects are a list to pick a name out of, so one without an
    // icon keeps the slot rather than pull its name out of line with
    // the rest.
    <ProjectIcon
      projectId={iconFrom?.projectId ?? project.id}
      deviceId={iconFrom?.deviceId}
      fallback={Folder}
    />
  );
  const name = (
    <span
      ref={nameRef}
      className={cn("min-w-0 truncate", missing && "line-through decoration-1")}
    >
      {project.name}
    </span>
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
      {lead}
      {name}
    </div>
  ) : missing ? (
    <div
      onContextMenu={onContextMenu}
      className={cn(baseClass, "text-muted-foreground/60")}
    >
      {lead}
      {name}
      <span className="shrink-0 text-3xs font-medium tracking-normal text-muted-foreground/60 normal-case">
        missing
      </span>
    </div>
  ) : expanded ? (
    <div
      onContextMenu={onContextMenu}
      className={cn(baseClass, "font-semibold text-foreground")}
    >
      {lead}
      {name}
      <TerrierMark terrier={terrier} />
      {badges}
    </div>
  ) : (
    // No disclosure arrow: picking a project goes into it, and an
    // arrow here would promise it opens in place. The row's fill
    // (ProjectRow) is what says it can be picked.
    <button
      type="button"
      onClick={onToggle}
      onContextMenu={onContextMenu}
      // doubutsu stripes the row as one pill and has this sit it out.
      data-slot="sidebar-project-pick"
      aria-current={current ? "true" : undefined}
      className={cn(
        baseClass,
        "transition-colors",
        current
          ? "text-accent-foreground"
          : "text-muted-foreground group-hover/project:text-foreground",
      )}
    >
      {lead}
      {name}
    </button>
  );

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger render={trigger} />
      <TooltipContent>{project.name}</TooltipContent>
    </Tooltip>
  );
}
