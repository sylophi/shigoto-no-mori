// A commit in the History tab's list (CommitRowView), opening it beside
// the list, or the Changes tab to amend it.
import type { ComponentProps } from "react";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { CommitRowView } from "@shigomori/ui/views/worktreeDetail/git/CommitRowView.tsx";

export function CommitRow({
  worktree,
  ...props
}: { worktree: Worktree } & Omit<
  ComponentProps<typeof CommitRowView>,
  "onOpen" | "onAmend"
>) {
  const nav = useWorktreeNav();
  return (
    <CommitRowView
      {...props}
      onOpen={() =>
        nav.toCommit(worktree.projectId, worktree.id, props.commit.hash, true)
      }
      onAmend={() =>
        nav.toDiff(worktree.projectId, worktree.id, { amend: true })
      }
    />
  );
}
