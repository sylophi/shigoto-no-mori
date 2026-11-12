import type { ReactNode } from "react";
import { BackButton } from "../../../primitives/back-button.tsx";
import { SegmentedControl } from "../../../primitives/segmented-control.tsx";
import { cn } from "../../../lib/utils.ts";

export type GitTab = "changes" | "stashes" | "history";

// No count where there is none, or where it couldn't be read (the
// Changes tab's own list says so).
const counted = (label: string, count: number | null) =>
  count ? `${label} ${count}` : label;

// The Git page's sidebar, as GitHub Desktop splits its left column: the
// Changes tab (the working tree's files, ticked into the next commit,
// with the branch and the commit box at its foot), the Stashes tab (the
// work set aside) and the History tab (the branch's commits, pushed and
// not, with the branch and its push and sync at its foot). The two most
// used sit at the ends, the easier targets. Each tab is the page's
// routes for it, and a switch replaces the page's entry, so Back still
// leaves. History opens on the newest commit (and is off without one),
// Stashes on the newest stash (GitPageSidebar binds the tabs). Picking
// a stash or a commit puts its files in the list's place, as the
// Changes tab lists the working tree's, under the way back to the
// list.
export function GitPageSidebarView({
  tab,
  onTab,
  warmTab,
  changedCount,
  stashCount,
  hasHistory,
  banner,
  files,
  onBack,
  stashList,
  historyList,
}: {
  tab: GitTab;
  onTab: (tab: GitTab) => void;
  // The reads a tab opens on, once the pointer rests on it.
  warmTab?: (tab: GitTab) => void;
  changedCount: number | null;
  stashCount: number;
  // A commit to open History on.
  hasHistory: boolean;
  // The operation stopped on conflicts (OperationBanner), over the
  // Changes tab's list.
  banner: ReactNode;
  // The page's file list: the Changes tab's content, or the files of
  // the stash or commit picked from another tab's list.
  files?: ReactNode;
  // Back from a picked one's files to its tab's list. With it the files
  // show in the list's place.
  onBack?: () => void;
  // The other tabs' lists (StashList, HistoryList).
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
          warm={warmTab}
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
          {files}
        </>
      ) : (
        <>
          {onBack && (
            <>
              <div className="px-2">
                <BackButton
                  label={tab === "stashes" ? "Stashes" : "Commits"}
                  onClick={onBack}
                  className="ml-0"
                />
              </div>
              {files}
            </>
          )}
          {/* Hidden under the files rather than unmounted, so the way
              back finds the list as it was left: its scroll, its search
              and its earlier commits open. */}
          <div
            className={cn("flex min-h-0 flex-1 flex-col", onBack && "hidden")}
          >
            {tab === "stashes" ? stashList : historyList}
          </div>
        </>
      )}
    </div>
  );
}
