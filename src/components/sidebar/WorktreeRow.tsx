import { FileDiff, Rocket, Terminal, Trash2 } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import {
  useWorktreeScriptActivity,
  type ScriptActivityKind,
} from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";

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
    pathname === `/projects/${worktree.projectId}/worktrees/${worktree.name}`;

  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeName",
          params: {
            projectId: worktree.projectId,
            worktreeName: worktree.name,
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
  if (worktree.changedCount === 0) return null;
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
