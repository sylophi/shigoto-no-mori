// A commit in the History tab's list (CommitRowView), opening it beside
// the list, or the Changes tab to amend it.
import type { ComponentProps } from "react";
import { useWarmGitPages } from "@/hooks/worktrees/useWarmGitPages";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { CommitRowView } from "@shigomori/ui/views/worktreeDetail/git/CommitRowView.tsx";

export function CommitRow({
  worktree,
  ...props
}: { worktree: Worktree } & Omit<
  ComponentProps<typeof CommitRowView>,
  "onOpen" | "warm" | "onAmend"
>) {
  const nav = useWorktreeNav();
  const warm = useWarmGitPages(worktree);
  return (
    <CommitRowView
      {...props}
      onOpen={() =>
        nav.toCommit(worktree.projectId, worktree.id, props.commit.hash, true)
      }
      warm={() => warm.commit(props.commit.hash)}
      onAmend={() =>
        nav.toDiff(worktree.projectId, worktree.id, { amend: true })
      }
    />
  );
}
