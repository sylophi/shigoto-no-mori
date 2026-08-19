import { BranchLabel } from "@/components/ui/branch-label";
import { RowStatusBadge, type RowStatus } from "@/components/ui/row-status";
import { Skeleton } from "@/components/ui/skeleton";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
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
// thing. The shared halves live in the two components below.

interface ForestSurveyRowProps {
  entry: ForestEntry;
  isLast: boolean;
}

// Line one is identity plus the status cluster the sidebar already speaks
// (same components, so the surfaces can't disagree). Line two is what
// you'd otherwise open the worktree to see.
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
        rowShell(isLast),
        dimClass({ shelved: worktree.shelved, isDeleting }),
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        isSelected && "bg-accent text-accent-foreground",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <RowIdentity worktree={worktree}>
          {isDeleting ? (
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
          )}
        </RowIdentity>
        <RowMeta entry={entry} detail={commit?.subject} />
      </div>
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
// status cluster's place, and its reason takes the commit subject's.
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
    // draws the edge line between rows in a theme that strips borders.
    <label
      data-slot="forest-row"
      className={cn(
        rowShell(isLast),
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
        className="mt-1 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <RowIdentity worktree={worktree}>
          <TidyVerdictBadge kind={verdict.kind} title={verdict.reason} />
        </RowIdentity>
        <RowMeta entry={entry} detail={verdict.reason} />
        {status.kind === "error" && (
          <p className="text-xs text-destructive select-text">
            {status.message}
          </p>
        )}
      </div>
      <div className="flex w-20 shrink-0 flex-col items-end gap-1">
        {disk ? (
          <span
            className="text-xs tabular-nums"
            title={`${disk.bytes.toLocaleString()} bytes on disk`}
          >
            {disk.partial ? "~" : ""}
            {formatBytes(disk.bytes)}
          </span>
        ) : (
          <Skeleton className="h-3.5 w-12" />
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

function rowShell(isLast: boolean): string {
  return cn(
    "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
    !isLast && "border-b border-border",
  );
}

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

// The branch, and whatever the row wants to say about its state.
function RowIdentity({
  worktree,
  children,
}: {
  worktree: ForestEntry["worktree"];
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        <BranchLabel
          branch={worktree.branch}
          detached={worktree.detached}
          suffixClassName="text-[10px]"
        />
      </span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

// Folder, one line of detail, and when things last happened. Same shape
// in both modes so a row doesn't jump when you enter tidy.
function RowMeta({
  entry,
  detail,
}: {
  entry: ForestEntry;
  detail: string | undefined;
}) {
  const { worktree } = entry;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
      {/* Capped rather than flexible: the folder name is the row's second
          identity, so it holds its width and lets the detail give ground
          first. */}
      <span className="max-w-48 shrink-0 truncate">{worktree.name}</span>
      {detail && (
        <>
          <Separator />
          <span className="min-w-0 flex-1 truncate">{detail}</span>
        </>
      )}
      <span className="tabular ml-auto flex shrink-0 items-center gap-1.5">
        {entry.lastCommitAt !== null && (
          <span title="Last commit">
            {formatRelativeTime(entry.lastCommitAt)}
          </span>
        )}
        {worktree.createdAt !== undefined && (
          <>
            {/* Only a separator when there's a timestamp to its left. A
                branch with no commits shows the age on its own. */}
            {entry.lastCommitAt !== null && <Separator />}
            <span title="Worktree age">
              {formatDuration(Date.now() - worktree.createdAt)} old
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function Separator() {
  return (
    <span aria-hidden className="shrink-0 opacity-50">
      ·
    </span>
  );
}
