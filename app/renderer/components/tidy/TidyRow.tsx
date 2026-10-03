import { BranchLabel } from "@/components/ui/branch-label";
import { Checkbox } from "@/components/ui/checkbox";
import { RowStatusBadge, type RowStatus } from "@/components/ui/row-status";
import { RowTag } from "@/components/ui/row-tag";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { InlineError } from "@/components/ui/inline-error";
import { useNow } from "@/hooks/ui/useNow";
import { formatBytes } from "@/lib/formatBytes";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import type { TidyEntry } from "./tidyModel";
import { TidyEntryTitle } from "./TidyEntryTitle";

interface TidyRowProps {
  entry: TidyEntry;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  onToggle: () => void;
  // The list spans every project, so a bare directory name isn't an
  // identity: two repos can both hold a "misty-otter". Off only inside a
  // project group, where the heading above already says it.
  showProject: boolean;
}

// One worktree in the tidy list. Wrapped in a <label> containing a
// native checkbox: that is the shape doubutsu.css hangs its row-hover
// stripe off, so the Animal Crossing treatment comes for free.
export function TidyRow({
  entry,
  checked,
  status,
  disabled,
  onToggle,
  showProject,
}: TidyRowProps) {
  const {
    worktree,
    project,
    verdict,
    disk,
    diskFailed,
    ageAt,
    lastActivityAt,
  } = entry;
  const now = useNow();
  const interactive = !disabled && status.kind !== "done";
  const ageTip =
    ageAt !== null
      ? `Last commit ${new Date(ageAt).toLocaleString()}`
      : undefined;
  // Only worth showing when someone actually touched files after the last
  // commit. Otherwise it just restates the commit date.
  const editedSince =
    ageAt !== null &&
    lastActivityAt !== null &&
    lastActivityAt - ageAt > 60 * 60 * 1000
      ? lastActivityAt
      : null;

  return (
    <label
      className={cn(
        "group flex items-start gap-3 px-3 py-3 text-sm",
        disabled && "opacity-70",
        interactive && "cursor-pointer transition-colors hover:bg-accent/30",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        disabled={!interactive}
        aria-label={`Select ${project.name} / ${worktree.name}`}
        className="mt-1"
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <TidyEntryTitle entry={entry} showProject={showProject}>
          {worktree.isExternal && <RowTag>External</RowTag>}
          {/* Shelved worktrees are hidden from the sidebar by default,
              which is exactly how one ends up forgotten on disk, so
              this list shows them, labelled. */}
          {worktree.shelved && <RowTag>Shelved</RowTag>}
        </TidyEntryTitle>

        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate font-mono select-text">
            <BranchLabel
              branch={worktree.branch}
              detached={worktree.detached}
            />
          </span>
          <span aria-hidden>·</span>
          <SimpleTooltip tip={ageTip}>
            <span className="shrink-0">
              {ageAt !== null
                ? `committed ${formatRelativeTime(ageAt, now)}`
                : "no commits"}
            </span>
          </SimpleTooltip>
          {editedSince !== null && (
            <>
              <span aria-hidden>·</span>
              <SimpleTooltip
                tip={`Files changed ${new Date(editedSince).toLocaleString()}`}
              >
                <span className="shrink-0">
                  edited {formatRelativeTime(editedSince, now)}
                </span>
              </SimpleTooltip>
            </>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{verdict.reason}</p>
        {status.kind === "error" && (
          <InlineError
            message={status.message}
            title="Couldn't tidy the worktree"
            className="text-xs text-destructive"
          />
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        {disk ? (
          <span className="text-sm tabular-nums">
            {disk.partial ? "~" : ""}
            {formatBytes(disk.bytes)}
          </span>
        ) : diskFailed ? (
          <SimpleTooltip tip="Couldn't measure this worktree">
            <span className="text-sm text-muted-foreground">&mdash;</span>
          </SimpleTooltip>
        ) : (
          <Skeleton className="h-4 w-14" />
        )}
        <RowStatusBadge
          status={status}
          labels={{
            running: "Removing",
            done: "Removed",
            error: "Removal failed",
          }}
        />
      </div>
    </label>
  );
}
