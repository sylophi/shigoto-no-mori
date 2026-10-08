import { AlertTriangle } from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Project } from "@shigomori/contracts/schemas";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { PinnedMark } from "@/components/shared/PinnedMark";
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
  // Pinned to the top of the list, which puts the pin after the name.
  pinned?: boolean;
  // The open project, heading the tree on its own: a title, with
  // nothing left for it to open.
  expanded?: boolean;
  // On the list: the page on screen belongs to this project.
  current?: boolean;
  // Picked off the list.
  onToggle?: () => void;
  missing?: boolean;
  // A relocation of the missing project is under way.
  relocating?: boolean;
  // Picking a missing project locates it, when it can be (not terrier's,
  // and its device takes commands from here).
  onLocate?: () => void;
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
// project name is `truncate`d, and its tooltip only opens while it is
// cut off.
export function ProjectHeader({
  project,
  iconFrom,
  badges,
  terrier = false,
  pinned = false,
  expanded,
  current,
  onToggle,
  missing,
  relocating,
  onLocate,
  listeners,
  onContextMenu,
  arrangeMode,
  reorderable = true,
}: ProjectHeaderProps) {
  // The same lead and name in every branch.
  const lead = missing ? (
    <AlertTriangle className="size-3 shrink-0 text-destructive/70" />
  ) : (
    <ProjectIcon
      projectId={iconFrom?.projectId ?? project.id}
      name={project.name}
      deviceId={iconFrom?.deviceId}
    />
  );
  const name = (
    <span
      className={cn("min-w-0 truncate", missing && "line-through decoration-1")}
    >
      {project.name}
    </span>
  );
  const missingBody = (
    <>
      {lead}
      {name}
      <span className="shrink-0 text-3xs font-medium tracking-normal text-muted-foreground/60 normal-case">
        {relocating ? "locating…" : "missing"}
      </span>
    </>
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
    onLocate === undefined ? (
      <div
        onContextMenu={onContextMenu}
        className={cn(baseClass, "text-muted-foreground/60")}
      >
        {missingBody}
      </div>
    ) : (
      <button
        type="button"
        onClick={onLocate}
        onContextMenu={onContextMenu}
        className={cn(
          baseClass,
          "text-muted-foreground/60 transition-colors hover:text-muted-foreground",
        )}
      >
        {missingBody}
      </button>
    )
  ) : expanded ? (
    <div
      onContextMenu={onContextMenu}
      className={cn(baseClass, "font-semibold text-foreground")}
    >
      {lead}
      {name}
      {pinned && <PinnedMark />}
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
      {pinned && <PinnedMark />}
    </button>
  );

  return (
    <SimpleTooltip whenTruncated tip={project.name}>
      {trigger}
    </SimpleTooltip>
  );
}
