import { useEffect, useState } from "react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import {
  useStashChanges,
  useWorktreeStashes,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { StashListView } from "@shigomori/ui/views/worktreeDetail/git/StashListView.tsx";

// The Git page's Stashes tab (StashListView), and the stash it makes.
export function StashList({
  worktree,
  selected,
}: {
  worktree: Worktree;
  selected: string | undefined;
}) {
  const nav = useWorktreeNav();
  const { data: listed } = useWorktreeStashes(worktree);
  const stashes = listed ?? [];
  const stashChanges = useStashChanges();
  const { canCommand } = useCommandAccess();
  const [message, setMessage] = useState("");
  // The stashes the branch had as a stash was made, until the list
  // shows the new one, which then opens. Another branch forgets it.
  const [before, setBefore] = useState<{
    readonly branch: string;
    readonly hashes: ReadonlySet<string>;
  } | null>(null);
  const { projectId, id: worktreeId, changedCount, branch } = worktree;
  const newest = stashes[0]?.hash;
  useEffect(() => {
    if (before === null) return;
    if (before.branch !== branch) return setBefore(null);
    if (newest === undefined || before.hashes.has(newest)) return;
    setBefore(null);
    nav.toStash(projectId, worktreeId, newest, true);
  }, [before, branch, newest, nav, projectId, worktreeId]);
  const submit = () => {
    if (changedCount === 0 || stashChanges.isPending) return;
    stashChanges.mutate(
      { projectId, worktreeId, message: message.trim() || undefined },
      {
        onSuccess: () => {
          setMessage("");
          if (listed !== undefined && !worktree.detached) {
            setBefore({
              branch,
              hashes: new Set(listed.map((stash) => stash.hash)),
            });
          }
        },
      },
    );
  };
  return (
    <StashListView
      stashes={stashes}
      selected={selected}
      changedCount={changedCount}
      canCommand={canCommand}
      message={message}
      onMessageChange={setMessage}
      pending={stashChanges.isPending}
      onSubmit={submit}
      onPick={(hash) => nav.toStash(projectId, worktreeId, hash, true)}
    />
  );
}
