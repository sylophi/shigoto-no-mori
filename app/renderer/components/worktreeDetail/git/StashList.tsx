import { useState } from "react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import {
  useStashChanges,
  useWorktreeStashes,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import type { Worktree } from "@shigomori/contracts/schemas";
import { StashListView } from "./StashListView";

// The Git page's Stashes tab (StashListView), and the stash it makes.
export function StashList({
  worktree,
  selected,
}: {
  worktree: Worktree;
  selected: string | undefined;
}) {
  const nav = useWorktreeNav();
  const { data: stashes = [], refetch } = useWorktreeStashes(worktree);
  const stashChanges = useStashChanges();
  const say = useWorktreeSuccessToast();
  const { canCommand } = useCommandAccess();
  const [message, setMessage] = useState("");
  const { projectId, id: worktreeId, changedCount } = worktree;
  const submit = () => {
    if (changedCount === 0 || stashChanges.isPending) return;
    stashChanges.mutate(
      { projectId, worktreeId, message: message.trim() || undefined },
      {
        onSuccess: async () => {
          setMessage("");
          say(worktree, `Stashed ${pluralize(changedCount, "file")}`);
          const { data } = await refetch();
          const newest = data?.[0]?.hash;
          if (newest) nav.toStash(projectId, worktreeId, newest, true);
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
