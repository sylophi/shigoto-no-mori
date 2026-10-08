import type { ReactNode } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shared/schemas";
import { GitTimeline } from "./GitTimeline";

export type GitTab = "changes" | "history";

// The Git page's sidebar, as GitHub Desktop splits its left column: the
// Changes tab (the working tree's files, ticked into the next commit,
// with the stashes and the commit box at its foot) and the History tab
// (the branch's commits as the Git timeline draws them, with the
// remote's and the primary branch's markers). Each tab is the page's
// routes for it, the changes or a commit (or the branch's whole diff),
// and a switch replaces the page's entry, so Back still leaves.
export function GitPageSidebar({
  worktree,
  tab,
  selected,
  changes,
}: {
  worktree: Worktree;
  tab: GitTab;
  // On the History tab: `branch` or `commit:<hash>`.
  selected?: string;
  // The Changes tab's content: the file list and its footer.
  changes?: ReactNode;
}) {
  const nav = useWorktreeNav();
  const head = worktree.recentCommits[0]?.hash;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pt-1 pb-2">
        <SegmentedControl
          aria-label="Git view"
          className="w-full"
          optionClassName="flex-1 px-2 py-1 text-xs"
          value={tab}
          onChange={(next) => {
            if (next === "changes") {
              nav.toDiff(worktree.projectId, worktree.id, { replace: true });
            } else if (head) {
              nav.toCommit(worktree.projectId, worktree.id, head, true);
            }
          }}
          options={[
            {
              value: "changes",
              label:
                worktree.changedCount > 0
                  ? `Changes ${worktree.changedCount}`
                  : "Changes",
            },
            { value: "history", label: "History", disabled: !head },
          ]}
        />
      </div>
      {tab === "changes" ? (
        changes
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <GitTimeline
            worktree={worktree}
            view={{ onGitPage: true, selected: selected ?? null }}
          />
        </div>
      )}
    </div>
  );
}
