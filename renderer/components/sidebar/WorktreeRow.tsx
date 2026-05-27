import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { BranchLabel } from "@/components/ui/branch-label";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { describePullRequest } from "@/lib/pullRequest";
import {
  useWorktreeScriptActivity,
  type ScriptActivityKind,
} from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";
import { ActivityIcon } from "./ActivityIcon";
import { StatusIndicator } from "./StatusIndicator";
import { StatusPill } from "./StatusPill";

interface WorktreeRowProps {
  worktree: Worktree;
}

export function WorktreeRow({ worktree }: WorktreeRowProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activity = useWorktreeScriptActivity(worktree.id);
  const isDeleting = useIsDeletingWorktree(worktree.id);
  // Not useMatchRoute: its stable function return reads from a hidden
  // store, which React Compiler can't see, so isSelected stays cached at
  // false. location.pathname is already decoded, so no encoding here.
  const isSelected =
    pathname === `/projects/${worktree.projectId}/worktrees/${worktree.id}`;

  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeId",
          params: {
            projectId: worktree.projectId,
            worktreeId: worktree.id,
          },
        })
      }
      title={describeRow(activity, isDeleting, worktree.shelved)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
        "hover:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
        isDeleting && "opacity-50",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          worktree.shelved && "opacity-60",
        )}
      >
        <span
          className={cn("truncate font-mono", isSelected && "font-medium")}
          title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
        >
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {worktree.name}
        </span>
      </div>
      <RowTrailing
        worktree={worktree}
        activity={activity}
        isDeleting={isDeleting}
      />
    </button>
  );
}

interface RowTrailingProps {
  worktree: Worktree;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
}

// The right-edge cluster. Deletion takes the whole row (the worktree is
// going away, so the trash standing alone reads as "destroying"); a
// running script just adds a leading activity icon to the normal cluster
// so status / PR / kind stay visible.
function RowTrailing({ worktree, activity, isDeleting }: RowTrailingProps) {
  // Deletion spans cleanup scripts + the final git remove; the script
  // activity covers only cleanup, so keep the trash pulsing for the
  // whole mutation regardless of which phase is active.
  if (isDeleting) {
    return <ActivityIcon kind="teardown" />;
  }
  return (
    <>
      {activity && <ActivityIcon kind={activity} />}
      <StatusIndicator worktree={worktree} />
      <PullRequestIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
    </>
  );
}

function describeRow(
  activity: ScriptActivityKind | null,
  isDeleting: boolean,
  shelved: boolean,
): string | undefined {
  if (isDeleting) return "Deleting worktree";
  if (activity === "setup") return "Running setup";
  if (activity === "teardown") return "Running teardown";
  if (activity === "package") return "Running a script";
  if (shelved) return "Shelved";
  return undefined;
}

function PullRequestIndicator({ worktree }: { worktree: Worktree }) {
  const { data: prs } = useProjectPullRequests(worktree.projectId);
  const pr = prs?.[worktree.branch];
  if (!pr) return null;
  const { Icon, tone, label } = describePullRequest(pr);
  return (
    <StatusPill
      icon={Icon}
      tone={tone}
      title={`${label} #${pr.number}`}
      aria-label={`${label} #${pr.number}`}
    />
  );
}
