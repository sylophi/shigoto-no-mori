import { SectionHeading } from "@/components/ui/section-heading";
import { useRepoMergeConfig } from "@/hooks/githubCli/useRepoMergeConfig";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import type { Worktree } from "@shared/schemas";
import { usePullRequestStack } from "@/hooks/pullRequests/usePullRequestStack";
import { PullRequestBody } from "./PullRequestBody";
import { PullRequestIdentity } from "./PullRequestIdentity";
import { StackList } from "./StackList";

export function PullRequestSection({ worktree }: { worktree: Worktree }) {
  // Skip the PR query on detached HEAD. There's no branch to ask gh
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
  const { data: projectPrs } = useProjectPullRequests(worktree.projectId);
  const stack = usePullRequestStack(worktree.projectId, worktree.branch);

  if (!enabled) return null;
  // While the initial query is in flight, show the heading only when
  // the sidebar's project map knows of a PR, so the section doesn't pop
  // in late. A branch with no PR stays empty instead
  // of flashing a heading that then drops out. hasOwn, since a branch
  // can be named "constructor".
  const holdPlace =
    isPending &&
    projectPrs !== undefined &&
    Object.hasOwn(projectPrs, worktree.branch);
  if (!pr && !holdPlace) return null;
  return (
    <section className="space-y-3">
      <SectionHeading>Pull request</SectionHeading>
      {pr && (
        <div className="space-y-4">
          <PullRequestIdentity worktree={worktree} pr={pr} />
          {stack && <StackList worktree={worktree} stack={stack} />}
          <PullRequestBody
            worktree={worktree}
            pr={pr}
            repoConfig={repoConfig ?? null}
            lastMergeMethod={shigomori?.lastMergeMethod}
          />
        </div>
      )}
    </section>
  );
}
