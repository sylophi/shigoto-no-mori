import type { ReactNode } from "react";
import { Command } from "cmdk";
import { FolderGit2, GitBranch } from "lucide-react";
import { WorktreeKindIcon, worktreeKind } from "@/components/WorktreeKindIcon";
import { StatusIndicator } from "@/components/sidebar/StatusIndicator";
import { BranchLabel } from "@/components/ui/branch-label";
import { ITEM_CLASS } from "@/components/ui/cmdk";
import { Kbd } from "@/components/ui/kbd";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";
import { assertNever, cn } from "@/lib/utils";
import type { Project, Worktree } from "@shared/schemas";
import type { PaletteItem } from "./paletteModel";

// Every row is one cmdk item on the shared picker chrome, loosened a
// notch: palette rows carry more per line than a file-browser row, so
// they get a bit more air and a wider gap.
export function PaletteRow({ item }: { item: PaletteItem }) {
  return (
    <Command.Item
      value={item.value}
      keywords={item.terms}
      onSelect={item.run}
      className={cn(ITEM_CLASS, "gap-2.5 py-2")}
    >
      <RowBody item={item} />
    </Command.Item>
  );
}

function RowBody({ item }: { item: PaletteItem }) {
  switch (item.kind) {
    case "worktree":
      return (
        <WorktreeBody
          project={item.project}
          worktree={item.worktree}
          isCurrent={item.isCurrent}
        />
      );
    case "project":
      return (
        <ProjectBody
          project={item.project}
          worktreeCount={item.worktreeCount}
        />
      );
    case "action":
      return (
        <ActionBody
          label={item.label}
          icon={item.icon}
          detail={item.detail}
          shortcut={item.shortcut}
        />
      );
    default:
      return assertNever(item);
  }
}

// Fixed-width icon slot so branch names line up across rows whatever
// glyph (or none) each one resolves to.
function IconSlot({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      {children}
    </span>
  );
}

function WorktreeBody({
  project,
  worktree,
  isCurrent,
}: {
  project: Project;
  worktree: Worktree;
  isCurrent: boolean;
}) {
  // Worktree directories are named independently of their branch, so show
  // both — unless they happen to agree, where repeating it is just noise.
  const meta =
    worktree.name === worktree.branch
      ? project.name
      : `${project.name} · ${worktree.name}`;
  return (
    <>
      <IconSlot>
        {worktreeKind(worktree) ? (
          <WorktreeKindIcon worktree={worktree} showTooltip={false} />
        ) : (
          <GitBranch className="size-3.5 text-muted-foreground/70" />
        )}
      </IconSlot>
      <span className="min-w-0 flex-1 truncate font-medium">
        <BranchLabel
          branch={worktree.branch}
          detached={worktree.detached}
          suffixClassName="text-xs"
        />
      </span>
      {isCurrent && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Current
        </span>
      )}
      <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
        {meta}
      </span>
      <StatusIndicator worktree={worktree} />
    </>
  );
}

function ProjectBody({
  project,
  worktreeCount,
}: {
  project: Project;
  worktreeCount: number;
}) {
  const iconSrc = useProjectIcon(project.id);
  return (
    <>
      <IconSlot>
        {iconSrc ? (
          <img
            src={iconSrc}
            alt=""
            draggable={false}
            className="size-4 rounded-sm object-contain select-none"
          />
        ) : (
          <FolderGit2 className="size-3.5 text-muted-foreground/70" />
        )}
      </IconSlot>
      <span className="min-w-0 flex-1 truncate font-medium">
        {project.name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {project.pathExists === false
          ? "Path missing"
          : `${worktreeCount} worktree${worktreeCount === 1 ? "" : "s"}`}
      </span>
    </>
  );
}

function ActionBody({
  label,
  icon,
  detail,
  shortcut,
}: {
  label: string;
  icon: ReactNode;
  detail?: string;
  shortcut?: string;
}) {
  return (
    <>
      <IconSlot>{icon}</IconSlot>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && (
        <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
          {detail}
        </span>
      )}
      {shortcut && <Kbd className="shrink-0">{shortcut}</Kbd>}
    </>
  );
}
