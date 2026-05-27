import type { Worktree } from "@shared/schemas";
import { BranchTitle } from "./BranchTitle";
import { WorktreeActivityIndicator } from "./WorktreeActivityIndicator";

export function BranchHeaderRow({ worktree }: { worktree: Worktree }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="min-w-0 flex-1">
        <BranchTitle worktree={worktree} />
      </div>
      <WorktreeActivityIndicator worktree={worktree} />
    </div>
  );
}
