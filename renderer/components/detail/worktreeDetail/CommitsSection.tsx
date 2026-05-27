import { useState } from "react";
import { ChevronRight, FileDiff, History } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { SectionHeading } from "@/components/ui/section-heading";
import type { Worktree } from "@shared/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { BranchHistoryDrawer } from "./BranchHistoryDrawer";
import { CommitRow } from "./CommitRow";

export function CommitsSection({ worktree }: { worktree: Worktree }) {
  const navigate = useNavigate();
  // The backend hands back up to 4 rows: 3 for the teaser plus 1 extra
  // we use as the "more available" probe. Slicing here keeps the
  // teaser's visible shape decoupled from that probe.
  const commits = worktree.recentCommits.slice(0, 3);
  const showAll = worktree.recentCommits.length > 3;
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Branch</SectionHeading>
        {worktree.changedCount > 0 ? (
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/projects/$projectId/worktrees/$worktreeId/diff",
                params: {
                  projectId: worktree.projectId,
                  worktreeId: worktree.id,
                },
              })
            }
            title="View uncommitted changes"
            className="tabular inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-amber-500 transition-colors hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FileDiff aria-hidden className="size-3.5" />
            {worktree.changedCount}{" "}
            {worktree.changedCount === 1 ? "file" : "files"} changed
            <ChevronRight aria-hidden className="size-3.5 opacity-60" />
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <WorktreePrimarySyncPill worktree={worktree} />
            <WorktreeSyncPill worktree={worktree} />
          </div>
        )}
      </div>
      {commits.length === 0 ? (
        <div className="text-sm text-muted-foreground">No commits yet.</div>
      ) : (
        <ul className="space-y-2">
          {commits.map((commit) => (
            <li key={commit.hash}>
              <CommitRow worktree={worktree} commit={commit} />
            </li>
          ))}
        </ul>
      )}
      {showAll && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            title="Browse full branch history"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <History aria-hidden className="size-3.5" />
            Show all
            <ChevronRight aria-hidden className="size-3.5 opacity-60" />
          </button>
        </div>
      )}
      <BranchHistoryDrawer
        worktree={worktree}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
    </section>
  );
}
