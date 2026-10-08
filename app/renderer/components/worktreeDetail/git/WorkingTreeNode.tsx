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
import { getBrowseLeafSegment } from "@shared/projectPaths";
import type { GitOperationState, Worktree } from "@shared/schemas";
import { TimelineRow } from "./TimelineRow";

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

// The top of the Git timeline: the work not yet committed. A merge or
// rebase stopped on conflicts takes the row, since the conflicts are in
// the working tree and nothing else moves until they are settled.
export function WorkingTreeNode({ worktree }: { worktree: Worktree }) {
  const { data: operation } = useWorktreeOperation(worktree);
  if (operation && (operation.operation !== null || operation.conflicted > 0)) {
    return <StoppedNode worktree={worktree} state={operation} />;
  }
  if (worktree.changedCount > 0) {
    return <ChangesNode worktree={worktree} />;
  }
  return (
    <TimelineRow
      node={<span className="size-2.5 rounded-full bg-muted-foreground/20" />}
    >
      <div className="py-1.5 text-sm text-muted-foreground">
        No uncommitted changes
      </div>
    </TimelineRow>
  );
}

function ChangesNode({ worktree }: { worktree: Worktree }) {
  const nav = useWorktreeNav();
  const { projectId, id: worktreeId } = worktree;
  const { data: files } = useWorktreeChanges(projectId, worktreeId);
  const stash = useStashChanges();
  const say = useWorktreeSuccessToast();
  const named = (files ?? []).slice(0, NAMED_FILES);
  const rest = worktree.changedCount - named.length;
  const review = () => nav.toDiff(projectId, worktreeId);
  return (
    <TimelineRow
      node={<CircleDot aria-hidden className="size-3.5 text-amber-500" />}
    >
      {/* The buttons drop under the count when the row is too narrow
          for both (a phone), rather than squeezing the file names. */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 py-1.5">
        <button
          type="button"
          onClick={review}
          className="min-w-0 flex-1 basis-48 text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <div className="text-sm">
            {pluralize(worktree.changedCount, "file")} changed
          </div>
          {named.length > 0 && (
            <div className="truncate text-xs text-muted-foreground">
              {named.map((file) => getBrowseLeafSegment(file.path)).join(", ")}
              {rest > 0 && ` and ${rest} more`}
            </div>
          )}
        </button>
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
        <Button variant="outline" size="xs" onClick={review}>
          Review and commit
          <ChevronRight />
        </Button>
      </div>
    </TimelineRow>
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
  const proceed = useContinueOperation();
  const abort = useAbortOperation();
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = proceed.isPending || abort.isPending;
  const what =
    state.operation === null
      ? "Conflicts in the working tree"
      : `${STOPPED[state.operation] ?? state.operation} stopped`;
  return (
    <TimelineRow
      node={<TriangleAlert aria-hidden className="size-3.5 text-amber-500" />}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 py-1.5">
        <div className="min-w-0 flex-1 basis-48">
          <div className="text-sm">{what}</div>
          <div className="text-xs text-muted-foreground">
            {state.conflicted > 0
              ? `${pluralize(state.conflicted, "file")} to resolve`
              : "Every conflict is resolved"}
          </div>
        </div>
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
        {state.conflicted > 0 ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => nav.toDiff(worktree.projectId, worktree.id)}
          >
            Resolve
            <ChevronRight />
          </Button>
        ) : (
          state.continuable && (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => proceed.mutate(scope)}
            >
              Continue
            </Button>
          )
        )}
      </div>
    </TimelineRow>
  );
}
