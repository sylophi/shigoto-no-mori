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
      title={describeRow(worktree, activity)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
        "hover:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
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
      <RowTrailing worktree={worktree} activity={activity} />
    </button>
  );
}

interface RowTrailingProps {
  worktree: Worktree;
  activity: ScriptActivityKind | null;
}

// The right-edge cluster: a single spinner / activity icon / location +
// status combo, chosen by priority. Pulled out so each case is a clean
// early return instead of a triple ternary.
function RowTrailing({ worktree, activity }: RowTrailingProps) {
  if (activity) {
    return <ActivityIcon kind={activity} />;
  }
  return (
    <>
      <StatusIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} />
    </>
  );
}

function describeRow(
  worktree: Worktree,
  activity: ScriptActivityKind | null,
): string | undefined {
  if (activity === "setup") return "Running setup";
  if (activity === "teardown") return "Running teardown";
  if (activity === "package") return "Running a script";
  if (worktree.isPrimary) return "Repo root";
  if (worktree.isExternal) return `External worktree at ${worktree.path}`;
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
    return (
      <span
        title={
          state.canPublish
            ? "Branch not yet published"
            : "Branch not yet published (no remote configured)"
        }
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
