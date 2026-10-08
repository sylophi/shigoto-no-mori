import type { ReactNode } from "react";
import type { Worktree } from "@shared/schemas";
import { GitTimeline } from "./GitTimeline";

// The Git page's sidebar, as GitHub Desktop lays out its left column:
// the worktree's timeline, with the selected row (the changes, a stash,
// a commit, everything the branch changes) opened to its files, and
// under it, pinned, whatever the selection keeps at hand: the commit
// box for the changes. The pane beside it shows what is selected.
export function GitPageSidebar({
  worktree,
  selected,
  files,
  footer,
}: {
  worktree: Worktree;
  // `changes`, `branch`, `commit:<hash>` or `stash:<hash>`.
  selected: string;
  files: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
        <GitTimeline
          worktree={worktree}
          view={{ onGitPage: true, selected, expanded: files }}
        />
      </div>
      {footer && <div className="shrink-0">{footer}</div>}
    </div>
  );
}
