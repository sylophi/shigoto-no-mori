// A project header's name and icon, drawn (ProjectHeader looks up the
// icon, the paw and whether the name overflows).
import type { ReactNode, Ref } from "react";
import { AlertTriangle } from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { ProjectIconView } from "@/components/shared/ProjectIconView";
import { TerrierPaw } from "@/components/shared/TerrierPaw";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ProjectHeaderViewProps {
  name: string;
  // The project's logo, as ProjectIconView takes it.
  iconSrc: string | null | undefined;
  // The merged tree's device badge cluster, rendered after the name of
  // the open project only: the list's rows are names alone, since every
  // row wearing them made the list a wall of icons.
  badges?: ReactNode;
  // The paw after the open project's name: some checkout in the
  // header's group is terrier-sourced, and this window marks them.
  showTerrierPaw?: boolean;
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
  // The name's span, for measuring whether it overflows, and the
  // answer: the tooltip naming the project only opens when it does.
  nameRef?: Ref<HTMLSpanElement>;
  isTruncated?: boolean;
}

const baseClass =
  "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium";

// Header row shared by the healthy and missing-project branches. The
// project name is `truncate`d, with a Tooltip that only opens when the
// text actually overflows.
export function ProjectHeaderView({
  name: projectName,
  iconSrc,
  badges,
  showTerrierPaw = false,
  expanded,
  current,
  onToggle,
  missing,
  listeners,
  onContextMenu,
  arrangeMode,
  reorderable = true,
  nameRef,
  isTruncated = false,
}: ProjectHeaderViewProps) {
  // The same lead and name in every branch; only one branch mounts, so
  // the ref lands once.
  const lead = missing ? (
    <AlertTriangle className="size-3 shrink-0 text-destructive/70" />
  ) : (
    <ProjectIconView name={projectName} src={iconSrc} />
  );
  const name = (
    <span
      ref={nameRef}
      className={cn("min-w-0 truncate", missing && "line-through decoration-1")}
    >
      {projectName}
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
      {showTerrierPaw && <TerrierPaw className="size-3" />}
      {badges}
    </div>
  ) : (
    // No disclosure arrow: picking a project goes into it, and an
    // arrow here would promise it opens in place. The row's fill
    // (ProjectRowView) is what says it can be picked.
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
      <TooltipContent>{projectName}</TooltipContent>
    </Tooltip>
  );
}
