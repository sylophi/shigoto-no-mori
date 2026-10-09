import type { ReactNode } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { HistoryList } from "./HistoryList";
import { OperationBanner } from "./OperationBanner";
import { StashList } from "./StashList";

export type GitTab = "changes" | "stashes" | "history";

const counted = (label: string, count: number) =>
  count > 0 ? `${label} ${count}` : label;

// The Git page's sidebar, as GitHub Desktop splits its left column: the
// Changes tab (the working tree's files, ticked into the next commit,
// with the branch and the commit box at its foot), the Stashes tab (the
// work set aside) and the History tab (the branch's commits, pushed and
// not, with the branch and its push and sync at its foot). The two most
// used sit at the ends, the easier targets. Each tab is the page's
// routes for it, and a switch replaces the page's entry, so Back still
// leaves. History opens on the newest commit (and is off without one),
// Stashes on the newest stash.
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <SegmentedControl
          aria-label="Git view"
          className="w-full"
          optionClassName="flex-1 justify-center px-1 py-0.5 text-xs"
          value={tab}
          onChange={(next) => {
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
          options={[
            {
              value: "changes",
              label: counted("Changes", worktree.changedCount),
            },
            {
              value: "stashes",
              label: counted("Stashes", stashes.length),
            },
            { value: "history", label: "History", disabled: !head },
          ]}
        />
      </div>
      {tab === "changes" ? (
        <>
          {/* A merge or rebase stopped on conflicts: settled in the list
              below, then continued (or abandoned) here. */}
          <div className="px-2 pb-1.5 empty:hidden">
            <OperationBanner worktree={worktree} onGitPage />
          </div>
          {changes}
        </>
      ) : tab === "stashes" ? (
        <StashList worktree={worktree} selected={selected} />
      ) : (
        <HistoryList worktree={worktree} selected={selected ?? null} />
      )}
    </div>
  );
}
