import { AlertTriangle, Copy as CopyIcon, X } from "lucide-react";
import { MaterialIcon } from "@/components/ui/material-icon";
import { cn } from "@/lib/utils";
import type {
  CarryOverEntry,
  CarryOverStat,
} from "@shigomori/contracts/schemas";
import { ModePickerView } from "./ModePickerView";
import { OnlyInWorktreesView } from "./OnlyInWorktreesView";
import { ChipButton } from "@/components/ui/chip-button";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface CarryOverRowProps {
  entry: CarryOverEntry;
  // Where the path currently exists. Undefined while still loading.
  stat: CarryOverStat | undefined;
  // .worktreeinclude already covers this path; the entry will be
  // auto-removed the next time a worktree is created.
  covered?: boolean;
  // "worktreeinclude" rows come from the repo's .worktreeinclude file:
  // always copy mode, edited in the file rather than removed here.
  origin?: "manual" | "worktreeinclude";
  onChangeMode?: (mode: CarryOverEntry["mode"]) => void;
  onRemove?: () => void;
}

export function CarryOverRowView({
  entry,
  stat,
  covered = false,
  origin = "manual",
  onChangeMode,
  onRemove,
}: CarryOverRowProps) {
  const missing =
    stat !== undefined && !stat.inPrimary && stat.worktrees.length === 0;
  const basename = entry.path.split("/").pop() ?? entry.path;
  const fromInclude = origin === "worktreeinclude";
  return (
    <div className="group flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <MaterialIcon
          kind={stat?.isDirectory ? "folder" : "file"}
          name={basename}
          className="size-4"
        />
        <SimpleTooltip whenTruncated tip={entry.path}>
          <span
            className={cn(
              "min-w-0 truncate font-mono text-xs",
              missing && "text-destructive",
            )}
          >
            {entry.path}
          </span>
        </SimpleTooltip>
        {missing && (
          <SimpleTooltip tip="Source doesn't exist in the main checkout or any worktree. New worktrees will skip this entry.">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-3xs font-medium text-destructive">
              <AlertTriangle className="size-3" />
              missing
            </span>
          </SimpleTooltip>
        )}
        {stat && (
          <OnlyInWorktreesView
            inPrimary={stat.inPrimary}
            worktrees={stat.worktrees}
            className="shrink-0"
          />
        )}
        {covered && (
          <SimpleTooltip tip=".worktreeinclude now covers this path; this entry will be removed the next time a worktree is created.">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-3xs font-medium text-amber-600 dark:text-amber-400">
              covered
            </span>
          </SimpleTooltip>
        )}
      </span>
      {fromInclude ? (
        <>
          <span className="shrink-0 text-2xs text-muted-foreground/70">
            used by <span className="font-mono">.worktreeinclude</span>
          </span>
          <SimpleTooltip tip="Matches a pattern in the repo's .worktreeinclude file, so it's copied into every new worktree. Edit that file to change or remove it.">
            <ChipButton disabled className="shrink-0 cursor-not-allowed">
              <CopyIcon className="size-3" />
              Copy
            </ChipButton>
          </SimpleTooltip>
          <SimpleTooltip tip="Remove it by editing .worktreeinclude in the repo.">
            <button
              type="button"
              disabled
              aria-label={`Remove ${entry.path}`}
              className="rounded-md p-1 text-muted-foreground/40"
            >
              <X className="size-3.5" />
            </button>
          </SimpleTooltip>
        </>
      ) : (
        <>
          <ModePickerView
            mode={entry.mode}
            onChange={(mode) => onChangeMode?.(mode)}
          />
          <IconButton
            onClick={onRemove}
            aria-label={`Remove ${entry.path}`}
            tone="destructive"
          >
            <X className="size-3.5" />
          </IconButton>
        </>
      )}
    </div>
  );
}
