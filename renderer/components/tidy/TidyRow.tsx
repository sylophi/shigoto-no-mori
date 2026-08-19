import { BranchLabel } from "@/components/ui/branch-label";
import { Checkbox } from "@/components/ui/checkbox";
import { RowStatusBadge, type RowStatus } from "@/components/ui/row-status";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/formatBytes";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { isSelectable, type TidyEntry } from "./tidyModel";
import { TidyEntryTitle } from "./TidyEntryTitle";

interface TidyRowProps {
  entry: TidyEntry;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  onToggle: () => void;
  isLast: boolean;
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
  isLast,
  showProject,
}: TidyRowProps) {
  const { worktree, project, verdict, disk, ageAt, lastActivityAt } = entry;
  const selectable = isSelectable(entry);
  const interactive = selectable && !disabled && status.kind !== "done";
  const ageTitle =
    ageAt !== null
      ? `Last commit ${new Date(ageAt).toLocaleString()}`
      : undefined;
  // Only worth showing when someone actually touched files after the last
  // commit -- otherwise it just restates the commit date.
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
        !isLast && "border-b border-border",
        disabled && "opacity-70",
        !selectable && "opacity-60",
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
          {worktree.isExternal && !worktree.isPrimary && (
            <RowTag>External</RowTag>
          )}
          {/* Shelved worktrees are hidden from the sidebar by default,
              which is exactly how one ends up forgotten on disk -- so
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
          <span className="shrink-0" title={ageTitle}>
            {ageAt !== null
              ? `committed ${formatRelativeTime(ageAt)}`
              : "no commits"}
          </span>
          {editedSince !== null && (
            <>
              <span aria-hidden>·</span>
              <span
                className="shrink-0"
                title={`Files changed ${new Date(editedSince).toLocaleString()}`}
              >
                edited {formatRelativeTime(editedSince)}
              </span>
            </>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{verdict.reason}</p>
        {status.kind === "error" && (
          <p className="text-xs text-destructive select-text">
            {status.message}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        {disk ? (
          <span
            className="text-sm tabular-nums"
            title={`${disk.bytes.toLocaleString()} bytes on disk`}
          >
            {disk.partial ? "~" : ""}
            {formatBytes(disk.bytes)}
          </span>
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

// Neutral marker for a property of the worktree itself, as opposed to
// the verdict badge's judgement about removing it.
function RowTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}
