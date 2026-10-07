import { useRepoMergeConfig } from "@/hooks/githubCli/useRepoMergeConfig";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import type { Worktree } from "@shared/schemas";
import { DescriptionSection } from "../DescriptionSection";
import { PullRequestBody } from "./PullRequestBody";

// What leads the page under a PR's header (PullRequestHeader): what
// the work is, with no heading, the way a PR's body follows its title,
// then what to do about the PR (merge it, or clean up after it).
export function PullRequestLead({
  worktree,
  description,
}: {
  worktree: Worktree;
  description: string | null;
}) {
  const { data: pr } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
  );
  const { data: repoConfig } = useRepoMergeConfig(worktree.projectId);
  const { data: shigomori } = useShigomoriConfig(worktree.projectId);
  if (description === null && !pr) return null;
  return (
    <div className="space-y-5">
      {description !== null && (
        <DescriptionSection
          // Folded again for another worktree or a new text.
          key={`${worktree.id}:${description}`}
          description={description}
          bare
        />
      )}
      {pr && (
        <PullRequestBody
          worktree={worktree}
          pr={pr}
          repoConfig={repoConfig ?? null}
          lastMergeMethod={shigomori?.lastMergeMethod}
          headed
        />
      )}
    </div>
  );
}
