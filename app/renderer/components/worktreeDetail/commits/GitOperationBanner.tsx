import { ChevronRight, TriangleAlert } from "lucide-react";
import {
  useAbortOperation,
  useContinueOperation,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import type { Worktree } from "@shared/schemas";

const DOING: Record<string, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  "git am": "git am",
  bisect: "Bisect",
  "cherry-pick or revert": "Cherry-pick",
};

// A merge, rebase, cherry-pick or revert the worktree is stopped in,
// from the app or a terminal, or conflicts a stash left behind. The
// conflicts are settled on the changes page. Once none are left, the
// operation can be continued here.
export function GitOperationBanner({ worktree }: { worktree: Worktree }) {
  const nav = useWorktreeNav();
  const { data: state } = useWorktreeOperation(worktree);
  const proceed = useContinueOperation();
  const abort = useAbortOperation();
  if (!state || (state.operation === null && state.conflicted === 0)) {
    return null;
  }
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = proceed.isPending || abort.isPending;
  const what =
    state.operation === null
      ? "Conflicts"
      : `${DOING[state.operation] ?? state.operation} stopped`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-amber-500" />
      <span className="min-w-0 flex-1">
        {what}
        <span className="text-muted-foreground">
          {" · "}
          {state.conflicted > 0
            ? `${pluralize(state.conflicted, "file")} to resolve`
            : "every conflict resolved"}
        </span>
      </span>
      <div className="flex items-center gap-1">
        {state.conflicted > 0 ? (
          <BannerButton
            onClick={() => nav.toDiff(worktree.projectId, worktree.id)}
          >
            Resolve
            <ChevronRight aria-hidden className="size-3.5 opacity-60" />
          </BannerButton>
        ) : (
          state.continuable && (
            <BannerButton disabled={busy} onClick={() => proceed.mutate(scope)}>
              Continue
            </BannerButton>
          )
        )}
        {state.operation !== null && (
          <BannerButton disabled={busy} onClick={() => abort.mutate(scope)}>
            Abort
          </BannerButton>
        )}
      </div>
    </div>
  );
}

function BannerButton(props: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors hover:bg-amber-500/15 focus-visible:outline-2 focus-visible:outline-amber-500 disabled:opacity-50"
    />
  );
}
