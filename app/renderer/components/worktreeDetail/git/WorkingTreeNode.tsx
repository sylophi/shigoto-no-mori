import type { ReactNode } from "react";
import { Archive, ChevronRight, CircleDot, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useAbortOperation,
  useContinueOperation,
  useStashChanges,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { getBrowseLeafSegment } from "@shared/projectPaths";
import type { GitOperationState, Worktree } from "@shared/schemas";
import { TimelineRow, useRowSelection, useTimelineView } from "./TimelineRow";

// How many changed files the row names before it just counts.
const NAMED_FILES = 4;

const STOPPED: Record<string, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  "git am": "git am",
  bisect: "Bisect",
  "cherry-pick or revert": "Cherry-pick",
};

// The top of the Git timeline: the work not yet committed, which opens
// the changes (on the Git page it is the changes, its files listed
// under it). A merge or rebase stopped on conflicts takes the row,
// since the conflicts are in the working tree and nothing else moves
// until they are settled.
export function WorkingTreeNode({ worktree }: { worktree: Worktree }) {
  const { data: operation } = useWorktreeOperation(worktree);
  if (operation && (operation.operation !== null || operation.conflicted > 0)) {
    return <StoppedNode worktree={worktree} state={operation} />;
  }
  if (worktree.changedCount > 0) return <ChangesNode worktree={worktree} />;
  return (
    <WorkingTreeRow
      worktree={worktree}
      node={<span className="size-2.5 rounded-full bg-muted-foreground/20" />}
      title={
        <span className="text-muted-foreground">No uncommitted changes</span>
      }
    />
  );
}

// The row's frame: its mark, a heading (with a line under it) that
// opens the changes, the moves beside it, and on the Git page the
// selected look with the files listed under it in place of the line.
function WorkingTreeRow({
  worktree,
  node,
  title,
  detail,
  actions,
}: {
  worktree: Worktree;
  node: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  const nav = useWorktreeNav();
  const { onGitPage } = useTimelineView();
  const { selected, expanded } = useRowSelection("changes");
  return (
    <TimelineRow node={node}>
      {/* The moves drop under the heading when the row is too narrow
          for both, rather than squeezing it. */}
      <div
        className={cn(
          "-mx-1.5 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md px-1.5 py-1.5 transition-colors",
          selected
            ? "bg-accent text-accent-foreground"
            : onGitPage && "hover:bg-accent/50",
        )}
      >
        <button
          type="button"
          aria-current={selected || undefined}
          onClick={() =>
            nav.toDiff(worktree.projectId, worktree.id, { replace: onGitPage })
          }
          className="min-w-0 flex-1 basis-40 text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <div className="text-sm">{title}</div>
          {detail && !selected && (
            <div className="truncate text-xs text-muted-foreground">
              {detail}
            </div>
          )}
        </button>
        {actions}
      </div>
      {expanded}
    </TimelineRow>
  );
}

function ChangesNode({ worktree }: { worktree: Worktree }) {
  const nav = useWorktreeNav();
  const { onGitPage } = useTimelineView();
  const { projectId, id: worktreeId } = worktree;
  const { data: files } = useWorktreeChanges(projectId, worktreeId);
  const stash = useStashChanges();
  const say = useWorktreeSuccessToast();
  const named = (files ?? []).slice(0, NAMED_FILES);
  const rest = worktree.changedCount - named.length;
  return (
    <WorkingTreeRow
      worktree={worktree}
      node={<CircleDot aria-hidden className="size-3.5 text-amber-500" />}
      title={`${pluralize(worktree.changedCount, "file")} changed`}
      detail={
        named.length > 0 && (
          <>
            {named.map((file) => getBrowseLeafSegment(file.path)).join(", ")}
            {rest > 0 && ` and ${rest} more`}
          </>
        )
      }
      // On the Git page the row is the review, and its file list's menu
      // stashes.
      actions={
        !onGitPage && (
          <>
            <Button
              variant="ghost"
              size="xs"
              disabled={stash.isPending}
              onClick={() =>
                stash.mutate(
                  { projectId, worktreeId },
                  {
                    onSuccess: () =>
                      say(
                        worktree,
                        `Stashed ${pluralize(worktree.changedCount, "file")}`,
                      ),
                  },
                )
              }
            >
              <Archive />
              Stash
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => nav.toDiff(projectId, worktreeId)}
            >
              Review and commit
              <ChevronRight />
            </Button>
          </>
        )
      }
    />
  );
}

function StoppedNode({
  worktree,
  state,
}: {
  worktree: Worktree;
  state: GitOperationState;
}) {
  const nav = useWorktreeNav();
  const { onGitPage } = useTimelineView();
  const proceed = useContinueOperation();
  const abort = useAbortOperation();
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = proceed.isPending || abort.isPending;
  return (
    <WorkingTreeRow
      worktree={worktree}
      node={<TriangleAlert aria-hidden className="size-3.5 text-amber-500" />}
      title={
        state.operation === null
          ? "Conflicts in the working tree"
          : `${STOPPED[state.operation] ?? state.operation} stopped`
      }
      detail={
        state.conflicted > 0
          ? `${pluralize(state.conflicted, "file")} to resolve`
          : "Every conflict is resolved"
      }
      actions={
        <>
          {state.operation !== null && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => abort.mutate(scope)}
            >
              Abort
            </Button>
          )}
          {state.conflicted > 0
            ? !onGitPage && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => nav.toDiff(worktree.projectId, worktree.id)}
                >
                  Resolve
                  <ChevronRight />
                </Button>
              )
            : state.continuable && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => proceed.mutate(scope)}
                >
                  Continue
                </Button>
              )}
        </>
      }
    />
  );
}
