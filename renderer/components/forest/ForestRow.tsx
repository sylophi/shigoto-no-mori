import { BranchLabel } from "@/components/ui/branch-label";
import { RowStatusBadge, type RowStatus } from "@/components/ui/row-status";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityIcon } from "@/components/sidebar/ActivityIcon";
import { PullRequestPill } from "@/components/sidebar/PullRequestPill";
import {
  ChangedFilesPill,
  RemoteSyncPill,
} from "@/components/sidebar/StatusIndicator";
import { useWorktreeRowState } from "@/components/sidebar/useWorktreeRowState";
import { formatBytes } from "@/lib/formatBytes";
import { formatDuration, formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { isSelectable, type ForestEntry } from "./forestFilters";
import { TidyVerdictBadge } from "./TidyVerdictBadge";

// Two rows rather than one with a mode flag: surveying and tidying agree
// on what a worktree looks like but not on what a row *is*. One is a link
// into the worktree, the other is a checkbox, and a row that both
// navigates and selects on the same click is a row that deletes the wrong
// thing. The shared halves live in the components at the bottom.
//
// Both are three lines: what this is, where it came from, and what it's
// doing. The folder name leads because it's what you'd type to cd there
// and what removal actually deletes, with the branch a line below in
// mono, where an identifier belongs.

interface ForestSurveyRowProps {
  entry: ForestEntry;
  isLast: boolean;
}

export function ForestSurveyRow({ entry, isLast }: ForestSurveyRowProps) {
  const { worktree, pullRequest } = entry;
  const { isSelected, open, activity, isDeleting, title } =
    useWorktreeRowState(worktree);
  const commit = worktree.recentCommits[0];

  return (
    <button
      type="button"
      data-slot="forest-row"
      onClick={open}
      title={title}
      className={cn(
        ROW_SHELL,
        !isLast && "border-b border-border",
        dimClass({ shelved: worktree.shelved, isDeleting }),
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        isSelected && "bg-accent text-accent-foreground",
      )}
    >
      <RowBody
        entry={entry}
        detail={commit?.subject}
        badges={
          isDeleting ? (
            <ActivityIcon kind="teardown" />
          ) : (
            <>
              {activity && <ActivityIcon kind={activity} />}
              {/* Both pills, not the sidebar's either/or: on this screen
                  "dirty AND 2 ahead" is what you're surveying for. */}
              <ChangedFilesPill worktree={worktree} />
              <RemoteSyncPill worktree={worktree} />
              <PullRequestPill pr={pullRequest} showNumber />
            </>
          )
        }
      />
    </button>
  );
}

interface ForestTidyRowProps {
  entry: ForestEntry;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  onToggle: () => void;
  isLast: boolean;
}

// The same worktree asked a different question: not "what is happening
// here" but "does removing this cost me anything". The verdict takes the
// status cluster's place, its reason takes the commit subject's, and the
// size earns a column of its own because it's the number you're scanning.
export function ForestTidyRow({
  entry,
  checked,
  status,
  disabled,
  onToggle,
  isLast,
}: ForestTidyRowProps) {
  const { worktree, verdict, disk } = entry;
  const selectable = isSelectable(entry);
  const interactive = selectable && !disabled && status.kind !== "done";

  return (
    // A <label> wrapping a native checkbox: that is the shape doubutsu.css
    // hangs its row-hover stripe off, so the Animal Crossing treatment
    // comes for free. It keeps the forest-row slot too, which is what
    // draws the line between rows in a theme that strips borders.
    <label
      data-slot="forest-row"
      className={cn(
        ROW_SHELL,
        !isLast && "border-b border-border",
        dimClass({
          shelved: worktree.shelved,
          disabled,
          unselectable: !selectable,
        }),
        interactive && "cursor-pointer hover:bg-accent/30",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={!interactive}
        aria-label={`Select ${worktree.name}`}
        className="mt-0.5 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
      />
      <RowBody
        entry={entry}
        detail={verdict.reason}
        badges={<TidyVerdictBadge kind={verdict.kind} title={verdict.reason} />}
        error={status.kind === "error" ? status.message : undefined}
      />
      <div className="flex w-20 shrink-0 flex-col items-end gap-1">
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

const ROW_SHELL =
  "flex w-full items-start gap-3 px-3 py-3 text-left text-sm transition-colors";

// One opacity, chosen by the strongest reason. Stacking the conditions as
// separate utilities left the winner up to Tailwind's emission order
// rather than the order written here.
function dimClass(state: {
  shelved?: boolean;
  isDeleting?: boolean;
  disabled?: boolean;
  unselectable?: boolean;
}): string | undefined {
  if (state.isDeleting) return "opacity-50";
  if (state.disabled) return "opacity-70";
  if (state.unselectable || state.shelved) return "opacity-60";
  return undefined;
}

interface RowBodyProps {
  entry: ForestEntry;
  // The row's third line: the commit subject while surveying, the reason
  // a worktree is or isn't safe while tidying.
  detail: string | undefined;
  badges: React.ReactNode;
  error?: string;
}

function RowBody({ entry, detail, badges, error }: RowBodyProps) {
  const { worktree } = entry;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">{worktree.name}</span>
        {worktree.isExternal && !worktree.isPrimary && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            External
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">{badges}</div>
      </div>

      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono">
          <BranchLabel
            branch={worktree.branch}
            detached={worktree.detached}
            suffixClassName="text-[10px]"
          />
        </span>
        {entry.lastCommitAt !== null && (
          <>
            <Divider />
            <span className="shrink-0 tabular-nums">
              committed {formatRelativeTime(entry.lastCommitAt)}
            </span>
          </>
        )}
        {worktree.createdAt !== undefined && (
          <>
            <Divider />
            <span className="shrink-0 tabular-nums">
              {formatDuration(Date.now() - worktree.createdAt)} old
            </span>
          </>
        )}
      </div>

      {detail && (
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      )}
      {error && <p className="text-xs text-destructive select-text">{error}</p>}
    </div>
  );
}

// A hairline, not a punctuation mark. Same job the interpunct was doing
// without putting a character in the middle of a sentence.
function Divider() {
  return (
    <span aria-hidden className="h-2.5 w-px shrink-0 bg-current opacity-25" />
  );
}
