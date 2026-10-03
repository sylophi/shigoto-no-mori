import type { PullRequestDetail, Worktree } from "@shared/schemas";

// The box under a pull request's identity, by what is left to do with
// it: merge it while it is open, clean up the worktree once it is
// closed or merged, or (on the primary checkout, which stays) catch
// the branch up with what was merged. Null when nothing is left.
export function pullRequestFollowUp(
  pr: Pick<PullRequestDetail, "state">,
  worktree: Pick<Worktree, "isPrimary">,
): "merge" | "cleanUp" | "catchUpPrimary" | null {
  if (pr.state === "OPEN") return "merge";
  if (!worktree.isPrimary) return "cleanUp";
  return pr.state === "MERGED" ? "catchUpPrimary" : null;
}
