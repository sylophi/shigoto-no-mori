import type { ReactNode } from "react";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { HistoryList } from "./HistoryList";
import { OperationBanner } from "./OperationBanner";
import { type GitTab, GitPageSidebarView } from "./GitPageSidebarView";
import { StashList } from "./StashList";

// The Git page's sidebar (GitPageSidebarView): its tabs are the
// page's routes.
export function GitPageSidebar({
  worktree,
  tab,
  selected,
  changes,
}: {
  worktree: Worktree;
  tab: GitTab;
  // On History, `branch` or `commit:<hash>`. On Stashes, the stash.
  selected?: string;
  // The Changes tab's content: the file list and its footer.
  changes?: ReactNode;
}) {
  const nav = useWorktreeNav();
  const { projectId, id: worktreeId } = worktree;
  const head = worktree.recentCommits[0]?.hash;
  const { data: stashes = [] } = useWorktreeStashes(worktree);
  const newestStash = stashes[0]?.hash;
  return (
    <GitPageSidebarView
      tab={tab}
      onTab={(next) => {
        if (next === "changes") {
          nav.toDiff(projectId, worktreeId, { replace: true });
        } else if (next === "history" && head) {
          nav.toCommit(projectId, worktreeId, head, true);
        } else if (next === "stashes") {
          if (newestStash) {
            nav.toStash(projectId, worktreeId, newestStash, true);
          } else {
            nav.toStashes(projectId, worktreeId, true);
          }
        }
      }}
      changedCount={worktree.changedCount}
      stashCount={stashes.length}
      hasHistory={head !== undefined}
      banner={<OperationBanner worktree={worktree} onGitPage />}
      changes={changes}
      stashList={<StashList worktree={worktree} selected={selected} />}
      historyList={
        <HistoryList worktree={worktree} selected={selected ?? null} />
      }
    />
  );
}
