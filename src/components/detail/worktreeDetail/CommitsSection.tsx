import { ChevronRight, FileDiff } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { SectionHeading } from "@/components/ui/section-heading";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { CommitSummary, Worktree } from "@shared/schemas";
import { WorktreeSyncPill } from "../WorktreeSyncPill";

export function CommitsSection({ worktree }: { worktree: Worktree }) {
  const navigate = useNavigate();
  const commits = worktree.recentCommits;
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
          <WorktreeSyncPill worktree={worktree} />
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
    </section>
  );
}

function CommitStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  // emerald-500 / rose-500 read close to Pierre's dark/light addition
  // and deletion hues without requiring shadow-DOM theme variables.
  return (
    <span
      aria-label={`${additions} additions, ${deletions} deletions`}
      title={`${additions} additions, ${deletions} deletions`}
      className="tabular inline-flex shrink-0 items-center gap-1.5 font-mono text-xs"
    >
      <span className="text-emerald-500">+{additions}</span>
      <span className="text-rose-500">−{deletions}</span>
    </span>
  );
}

function CommitRow({
  worktree,
  commit,
}: {
  worktree: Worktree;
  commit: CommitSummary;
}) {
  const navigate = useNavigate();
  const onClick = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
      params: {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        hash: commit.hash,
      },
    });
  return (
    <button
      type="button"
      onClick={onClick}
      title="View this commit's diff"
      className="-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="w-full truncate text-sm">{commit.subject}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{commit.hash}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span>{commit.author}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <RelativeDate date={commit.date} />
        </div>
      </div>
      {(commit.additions > 0 || commit.deletions > 0) && (
        <CommitStats
          additions={commit.additions}
          deletions={commit.deletions}
        />
      )}
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/40"
      />
    </button>
  );
}

function RelativeDate({ date }: { date: string }) {
  const value = new Date(date);
  return (
    <span title={value.toLocaleString()}>
      {formatRelativeTime(value.getTime())}
    </span>
  );
}
