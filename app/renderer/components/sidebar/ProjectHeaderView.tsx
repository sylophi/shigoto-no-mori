import { AlertTriangle, ChevronRight } from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import type { Project } from "@shigomori/contracts/schemas";
import { PinnedMarkView } from "@shigomori/ui/views/shared/PinnedMarkView.tsx";
import { TerrierPawView } from "@shigomori/ui/views/shared/TerrierPawView.tsx";

interface ProjectHeaderProps {
  project: Project;
  // The project's icon (ProjectIcon): a project only peers hold reads
  // it off one of them.
  icon: React.ReactNode;
  // The merged tree's device badge cluster, rendered after the name of
  // the open (or inline, an unfolded) project only: the list's rows are
  // names alone, since every row wearing them made the list a wall of
  // icons.
  badges?: React.ReactNode;
  // Some checkout in the header's group is terrier-sourced and Mark
  // terrier projects is on (useSidebarMarks), which puts the paw after
  // the open project's name.
  terrier?: boolean;
  // Pinned to the top of the list, which puts the pin after the name.
  pinned?: boolean;
  // The open project, heading the tree on its own: a title, with
  // nothing left for it to open.
  expanded?: boolean;
  // On the inline list, whether the project is folded to its header,
  // which picking flips in place.
  folded?: boolean;
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
export function ProjectHeaderView({
  project,
  icon,
  badges,
  terrier = false,
  pinned = false,
  expanded,
  folded,
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
    icon
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
      {pinned && <PinnedMarkView />}
      {terrier && <TerrierPawView className="size-3" />}
      {badges}
    </div>
  ) : (
    // A disclosure arrow only inline: elsewhere picking a project goes
    // into it, and an arrow would promise it opens in place. The row's
    // fill (ProjectRow) is what says it can be picked.
    <button
      type="button"
      onClick={onToggle}
      onContextMenu={onContextMenu}
      // doubutsu stripes the row as one pill and has this sit it out.
      data-slot="sidebar-project-pick"
      aria-current={current ? "true" : undefined}
      aria-expanded={folded === undefined ? undefined : !folded}
      className={cn(
        baseClass,
        "transition-colors",
        current && folded !== false
          ? "text-accent-foreground"
          : folded === undefined
            ? "text-muted-foreground group-hover/project:text-foreground"
            : "text-foreground",
        // Inline, a project heads its rows like the open project's
        // title, under its owner's quieter label.
        folded !== undefined && "font-semibold",
      )}
    >
      {folded !== undefined && (
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            !folded && "rotate-90",
          )}
        />
      )}
      {lead}
      {name}
      {pinned && <PinnedMarkView />}
      {folded === false && (
        <>
          {terrier && <TerrierPawView className="size-3" />}
          {badges}
        </>
      )}
    </button>
  );

  return (
    <SimpleTooltip whenTruncated tip={project.name}>
      {trigger}
    </SimpleTooltip>
  );
}
