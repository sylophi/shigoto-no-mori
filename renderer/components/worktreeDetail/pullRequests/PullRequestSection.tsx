import { SectionHeading } from "@/components/ui/section-heading";
import { useRepoMergeConfig } from "@/hooks/githubCli/useRepoMergeConfig";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import type { Worktree } from "@shared/schemas";
import { PullRequestBody } from "./PullRequestBody";
import { PullRequestRefreshIndicator } from "./PullRequestRefreshIndicator";

export function PullRequestSection({ worktree }: { worktree: Worktree }) {
  // Skip the PR query on detached HEAD — there's no branch to ask gh
  // about, and the eager enabled-flag spares the wasted IPC.
  const enabled = !worktree.detached;
  const { data: pr, isPending } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
    { enabled },
  );
  // Fire repo + shigomori queries in parallel with the PR query so the
  // merge box has its inputs ready as soon as the PR resolves.
  const { data: repoConfig } = useRepoMergeConfig(worktree.projectId);
  const { data: shigomori } = useShigomoriConfig(worktree.projectId);

  if (!enabled) return null;
  // While the initial query is in flight we still show the heading +
  // refresh indicator so the page doesn't pop content in late. Once
  // resolved with no PR, the section drops out entirely.
  if (!pr && !isPending) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Pull request</SectionHeading>
        <PullRequestRefreshIndicator worktree={worktree} />
      </div>
      {pr && (
        <PullRequestBody
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig ?? null}
          lastMergeMethod={shigomori?.lastMergeMethod}
        />
      )}
    </section>
  );
}
