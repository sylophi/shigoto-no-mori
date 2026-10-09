// What to do about the worktree's PR (PullRequestBody picks which):
// merge it while it's open, clean up after it once it's closed or
// merged, or, on the primary checkout, step off its merged branch.
import type { ReactNode } from "react";

export function PullRequestBodyView({
  mergeBox,
  closedBox,
  mergedPrimaryBox,
}: {
  // The merge box (MergeBox), the closed PR's (ClosedPullRequestBox),
  // and the primary checkout's on a merged branch
  // (MergedPrimaryBranchBox), whichever apply.
  mergeBox?: ReactNode;
  closedBox?: ReactNode;
  mergedPrimaryBox?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      {mergeBox}
      {closedBox}
      {mergedPrimaryBox}
    </div>
  );
}
