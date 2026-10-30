// A worktree's pages (its page, the diffs, the files) and its terminal
// drawer, which stays as they change: under the page, or at the side,
// beside it.
import type { ReactNode } from "react";

export function WorktreePagesView({
  drawer,
  side,
  children,
}: {
  drawer: ReactNode;
  side: boolean;
  children: ReactNode;
}) {
  // One shape for both docks, so a switch keeps the page mounted. The
  // outer box is `relative`: the side drawer measures it as its offset
  // parent.
  return (
    <div className="relative flex h-full">
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {!side && drawer}
      </div>
      {side && drawer}
    </div>
  );
}
