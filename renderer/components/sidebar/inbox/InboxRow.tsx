import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { BranchLabel } from "@/components/ui/branch-label";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { ScriptActivityKind } from "@/store/scriptRuns";
import {
  worktreeLastActivityAt,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";
import { ActivityIcon } from "../ActivityIcon";
import { ProjectIcon } from "../ProjectIcon";
import { PullRequestPill } from "../PullRequestPill";
import { ChangedFilesPill, RemoteSyncPill } from "../StatusIndicator";
import { useWorktreeRowState } from "../useWorktreeRowState";

interface InboxRowProps {
  worktree: Worktree;
  projectName: string;
  pr: PullRequest | undefined;
}

// The inbox row answers a different question from the tree row. In the
// tree you already know the project and you're picking a branch out of
// a short list, so one line of chrome is enough. Here every row comes
// from somewhere else and you're triaging: which repo, which branch,
// what state it's in, and when it last moved. That's three lines, and
// it's why this isn't WorktreeRow with a prop. The behaviour the two do
// share lives in useWorktreeRowState.
//
//   [icon] project                                  14m ago
//   feat/the-branch                            ±3  ↑2  #142
//   [kind] dirname
export function InboxRow({ worktree, projectName, pr }: InboxRowProps) {
  const { isSelected, open, activity, isDeleting, title } =
    useWorktreeRowState(worktree);

  return (
    <button
      type="button"
      onClick={open}
      title={title}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none",
        "hover:bg-accent/60 focus-visible:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
        isDeleting && "opacity-50",
        worktree.shelved && !isSelected && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <ProjectIcon
          projectId={worktree.projectId}
          className="size-3"
          fallback={Folder}
        />
        <span className="min-w-0 truncate font-medium">{projectName}</span>
        <TrailingSlot
          worktree={worktree}
          activity={activity}
          isDeleting={isDeleting}
        />
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs",
            // Weight is reserved for "this is the one you have open",
            // same as the tree row. Bolding every branch spends the
            // page's only emphasis on the thing every row has.
            isSelected && "font-medium",
          )}
        >
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        <ChangedFilesPill worktree={worktree} />
        <RemoteSyncPill worktree={worktree} />
        <PullRequestPill pr={pr} showNumber />
      </div>

      {/* The worktree's own name gets a line to itself rather than
          sharing one with the project: they're both "where is this",
          and side by side the longer one just eats the other.
          The kind glyph leads it, since it describes this worktree and
          not the project above. Shelved is the one kind left out: it
          would restate the shelf header the row is already under. The
          primary's house glyph stays -- when it's opted into the inbox
          it's the only thing telling the root apart from a worktree
          named after the project. */}
      <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/70">
        {!worktree.shelved && (
          <WorktreeKindIcon worktree={worktree} showTooltip={false} />
        )}
        <span className="min-w-0 truncate">{worktree.name}</span>
      </span>
    </button>
  );
}

// Right end of the context line: normally "when did this last move",
// which is what the inbox sorts on. A running script or a delete in
// flight displaces it -- those are happening now, so they outrank a
// timestamp.
function TrailingSlot({
  worktree,
  activity,
  isDeleting,
}: {
  worktree: Worktree;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
}) {
  const activityAt = worktreeLastActivityAt(worktree);

  return (
    <span className="ml-auto flex shrink-0 items-center">
      {isDeleting ? (
        <ActivityIcon kind="teardown" />
      ) : activity ? (
        <ActivityIcon kind={activity} />
      ) : (
        <span className="tabular">
          {activityAt > 0 ? formatRelativeTime(activityAt) : "no activity"}
        </span>
      )}
    </span>
  );
}
