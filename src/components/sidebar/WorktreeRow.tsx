import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CloudUpload,
  FileDiff,
  GitCompareArrows,
  Rocket,
  Terminal,
  Trash2,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { useIsDeletingWorktree } from "@/hooks/useWorktrees";
import { useProjectPullRequests } from "@/hooks/useProjectPullRequests";
import { describePullRequest, type PullRequestTone } from "@/lib/pullRequest";
import {
  useWorktreeScriptActivity,
  type ScriptActivityKind,
} from "@/store/scriptRuns";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";

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
      title={describeRow(activity, isDeleting)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
        "hover:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
        isDeleting && "opacity-50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate font-mono",
            isSelected && "font-medium",
            worktree.detached && "text-muted-foreground",
          )}
          title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
        >
          {worktree.branch}
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

// The right-edge cluster: a single spinner / activity icon / location +
// status combo, chosen by priority. Pulled out so each case is a clean
// early return instead of a triple ternary.
function RowTrailing({ worktree, activity, isDeleting }: RowTrailingProps) {
  // Deletion spans cleanup scripts + the final git remove; the script
  // activity covers only cleanup, so keep the trash pulsing for the
  // whole mutation regardless of which phase is active.
  if (isDeleting) {
    return <ActivityIcon kind="teardown" />;
  }
  if (activity) {
    return <ActivityIcon kind={activity} />;
  }
  return (
    <>
      <StatusIndicator worktree={worktree} />
      <PullRequestIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
    </>
  );
}

function describeRow(
  activity: ScriptActivityKind | null,
  isDeleting: boolean,
): string | undefined {
  if (isDeleting) return "Deleting worktree";
  if (activity === "setup") return "Running setup";
  if (activity === "teardown") return "Running teardown";
  if (activity === "package") return "Running a script";
  return undefined;
}

function ActivityIcon({ kind }: { kind: ScriptActivityKind }) {
  if (kind === "setup") {
    return (
      <Rocket
        aria-label="Setup running"
        className="size-3 shrink-0 animate-pulse text-emerald-500"
      />
    );
  }
  if (kind === "teardown") {
    return (
      <Trash2
        aria-label="Teardown running"
        className="size-3 shrink-0 animate-pulse text-destructive"
      />
    );
  }
  return (
    <Terminal
      aria-label="Script running"
      className="size-3 shrink-0 animate-pulse text-violet-500"
    />
  );
}

function PullRequestIndicator({ worktree }: { worktree: Worktree }) {
  const { data: prs } = useProjectPullRequests(worktree.projectId);
  const pr = prs?.[worktree.branch];
  if (!pr) return null;
  const { Icon, tone, label } = describePullRequest(pr);
  return (
    <span
      title={`${label} #${pr.number}`}
      aria-label={`${label} #${pr.number}`}
      className={cn(
        "inline-flex shrink-0 items-center text-[10px]",
        TONE_CLASSES[tone],
      )}
    >
      <Icon aria-hidden className="size-3" />
    </span>
  );
}

const TONE_CLASSES: Record<PullRequestTone, string> = {
  emerald: "text-emerald-500",
  violet: "text-violet-500",
  rose: "text-rose-500",
  slate: "text-muted-foreground",
};

function StatusIndicator({ worktree }: { worktree: Worktree }) {
  if (worktree.changedCount > 0) {
    const noun = worktree.changedCount === 1 ? "file" : "files";
    const label = `${worktree.changedCount} ${noun} changed`;
    return (
      <span
        title={label}
        aria-label={label}
        className="tabular inline-flex shrink-0 items-center gap-0.5 text-[10px] text-amber-500"
      >
        <FileDiff aria-hidden className="size-3" />
        {worktree.changedCount}
      </span>
    );
  }
  const state = deriveRemoteSyncState(worktree);
  if (state.kind === "detached" || state.kind === "synced") return null;

  // Each remote-sync state has the same compact shape: icon + (optional)
  // count, tone-colored. The detail header carries the actions and full
  // labels; this is just a "needs attention" signal for the sidebar.
  if (state.kind === "publish") {
    // Without a remote there's no action to take, so the icon would just be
    // noise on every "personal" repo without an origin. Detail header still
    // shows the disabled Publish button for discoverability.
    if (!state.canPublish) return null;
    return (
      <span
        title="Branch not yet published"
        aria-label="Unpublished branch"
        className="inline-flex shrink-0 items-center text-[10px] text-violet-500"
      >
        <CloudUpload aria-hidden className="size-3" />
      </span>
    );
  }
  if (state.kind === "ahead") {
    return (
      <span
        title={`${state.ahead} commit${state.ahead === 1 ? "" : "s"} to push`}
        aria-label={`${state.ahead} ahead`}
        className="tabular inline-flex shrink-0 items-center gap-0.5 text-[10px] text-emerald-500"
      >
        <ArrowUp aria-hidden className="size-3" />
        {state.ahead}
      </span>
    );
  }
  if (state.kind === "behind") {
    return (
      <span
        title={`${state.behind} commit${state.behind === 1 ? "" : "s"} to pull`}
        aria-label={`${state.behind} behind`}
        className="tabular inline-flex shrink-0 items-center gap-0.5 text-[10px] text-sky-500"
      >
        <ArrowDown aria-hidden className="size-3" />
        {state.behind}
      </span>
    );
  }
  if (state.kind === "pullAndPush") {
    return (
      <span
        title={`${state.ahead} ahead, ${state.behind} behind -- mergeable`}
        aria-label={`${state.ahead} ahead, ${state.behind} behind`}
        className="tabular inline-flex shrink-0 items-center gap-0.5 text-[10px] text-indigo-500"
      >
        <ArrowDownUp aria-hidden className="size-3" />
        {state.ahead}/{state.behind}
      </span>
    );
  }
  return (
    <span
      title={`Diverged: ${state.ahead} ahead, ${state.behind} behind`}
      aria-label={`Diverged ${state.ahead}/${state.behind}`}
      className="tabular inline-flex shrink-0 items-center gap-0.5 text-[10px] text-rose-500"
    >
      <GitCompareArrows aria-hidden className="size-3" />
      {state.ahead}/{state.behind}
    </span>
  );
}
