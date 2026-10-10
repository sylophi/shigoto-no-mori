import type { ReactNode } from "react";
import { SegmentedControl } from "../../../primitives/segmented-control.tsx";

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
// Stashes on the newest stash (GitPageSidebar binds the tabs).
export function GitPageSidebarView({
  tab,
  onTab,
  changedCount,
  stashCount,
  hasHistory,
  banner,
  changes,
  stashList,
  historyList,
}: {
  tab: GitTab;
  onTab: (tab: GitTab) => void;
  changedCount: number;
  stashCount: number;
  // A commit to open History on.
  hasHistory: boolean;
  // The operation stopped on conflicts (OperationBanner), over the
  // Changes tab's list.
  banner: ReactNode;
  // The tabs' lists (the changes the page hands in, StashList,
  // HistoryList).
  changes?: ReactNode;
  stashList: ReactNode;
  historyList: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <SegmentedControl
          aria-label="Git view"
          className="w-full"
          optionClassName="flex-1 justify-center px-1 py-0.5 text-xs"
          value={tab}
          onChange={onTab}
          options={[
            {
              value: "changes",
              label: counted("Changes", changedCount),
            },
            {
              value: "stashes",
              label: counted("Stashes", stashCount),
            },
            { value: "history", label: "History", disabled: !hasHistory },
          ]}
        />
      </div>
      {tab === "changes" ? (
        <>
          {/* A merge or rebase stopped on conflicts: settled in the list
              below, then continued (or abandoned) here. */}
          <div className="px-2 pb-1.5 empty:hidden">{banner}</div>
          {changes}
        </>
      ) : tab === "stashes" ? (
        stashList
      ) : (
        historyList
      )}
    </div>
  );
}
