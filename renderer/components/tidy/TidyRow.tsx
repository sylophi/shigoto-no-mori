import { BranchLabel } from "@/components/ui/branch-label";
import { RowStatusBadge, type RowStatus } from "@/components/ui/row-status";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/formatBytes";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { isSelectable, type TidyEntry } from "./tidyModel";
import { TidyVerdictBadge } from "./TidyVerdictBadge";

interface TidyRowProps {
  entry: TidyEntry;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  onToggle: () => void;
  isLast: boolean;
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
}: TidyRowProps) {
  const { worktree, verdict, disk, ageAt, lastActivityAt } = entry;
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
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={!interactive}
        aria-label={`Select ${worktree.name}`}
        className="mt-1 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium select-text">
            {worktree.name}
          </span>
          <TidyVerdictBadge kind={verdict.kind} />
          {worktree.isExternal && !worktree.isPrimary && (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              External
            </span>
          )}
        </div>

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
