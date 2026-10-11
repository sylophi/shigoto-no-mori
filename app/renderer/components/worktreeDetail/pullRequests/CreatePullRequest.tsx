import { useState } from "react";
import { GitPullRequest } from "lucide-react";
import { CreatePullRequestDialog } from "@/components/newPullRequest/CreatePullRequestDialog";
import { useRepoMergeConfig } from "@/hooks/githubCli/useRepoMergeConfig";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import type { Worktree } from "@shared/schemas";
import { SyncActionButton } from "../SyncActionButton";

// The Git heading's way to a first pull request, opening the dialog
// that writes it: offered on a branch with commits of its own and no PR
// yet, in a repo on GitHub (the merge config only reads there). None
// on a peer that takes no commands from here.
export function CreatePullRequestPill({
  worktree,
  ownCommits,
}: {
  worktree: Worktree;
  ownCommits: number;
}) {
  const [open, setOpen] = useState(false);
  const { canCommand } = useCommandAccess();
  const offered =
    !worktree.isPrimary &&
    !worktree.detached &&
    !worktree.mergedIntoPrimary &&
    worktree.primaryBranch !== undefined &&
    worktree.branch !== worktree.primaryBranch &&
    ownCommits > 0;
  const { data: pr } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
    { enabled: offered },
  );
  const { data: repoConfig } = useRepoMergeConfig(worktree.projectId);
  if (!canCommand || !offered || pr !== null || !repoConfig) return null;
  return (
    <>
      <SyncActionButton
        tone="emerald"
        icon={GitPullRequest}
        label="Create pull request"
        pending={false}
        onClick={() => setOpen(true)}
      />
      {open && (
        <CreatePullRequestDialog
          worktree={worktree}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
