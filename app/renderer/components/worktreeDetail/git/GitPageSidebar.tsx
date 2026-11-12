import type { ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useWarmGitPages } from "@/hooks/worktrees/useWarmGitPages";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { HistoryList } from "./HistoryList";
import { OperationBanner } from "./OperationBanner";
import {
  type GitTab,
  GitPageSidebarView,
} from "@shigomori/ui/views/worktreeDetail/git/GitPageSidebarView.tsx";
import { StashList } from "./StashList";

// The Git page's sidebar (GitPageSidebarView): its tabs are the
// page's routes, and so is whether a picked stash or commit shows its
// files or its tab's list (the routes' `list`).
export function GitPageSidebar({
  worktree,
  tab,
  selected,
  files,
}: {
  worktree: Worktree;
  tab: GitTab;
  // On History, `branch` or `commit:<hash>`. On Stashes, the stash.
  selected?: string;
  // The page's file list (on Changes, with its footer).
  files?: ReactNode;
}) {
  const nav = useWorktreeNav();
  const navigate = useNavigate();
  const { list } = useSearch({ strict: false }) as { list?: true };
  const showsFiles = tab !== "changes" && !list && selected !== undefined;
  const warm = useWarmGitPages(worktree);
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
          nav.toCommitList(projectId, worktreeId, head);
        } else if (next === "stashes") {
          if (newestStash) {
            nav.toStashList(projectId, worktreeId, newestStash);
          } else {
            nav.toStashes(projectId, worktreeId, true);
          }
        }
      }}
      warmTab={(next) => {
        if (next === "changes") warm.changes();
        else if (next === "history" && head) warm.commit(head);
        else if (next === "stashes" && newestStash) warm.stash(newestStash);
      }}
      changedCount={worktree.changedCount}
      stashCount={stashes.length}
      hasHistory={head !== undefined}
      banner={<OperationBanner worktree={worktree} onGitPage />}
      files={files}
      onBack={
        showsFiles
          ? () =>
              void navigate({
                to: ".",
                search: (search: Record<string, unknown>) => ({
                  ...search,
                  list: true,
                }),
                replace: true,
              } as never)
          : undefined
      }
      stashList={<StashList worktree={worktree} selected={selected} />}
      historyList={
        <HistoryList worktree={worktree} selected={selected ?? null} />
      }
    />
  );
}
