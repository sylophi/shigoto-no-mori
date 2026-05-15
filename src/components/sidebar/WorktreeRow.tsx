import {
  ExternalLink,
  House,
  Loader2,
  Rocket,
  Terminal,
  Trash2,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  useWorktreeScriptActivity,
  type ScriptActivityKind,
} from "@/store/scriptRuns";
import { useWorktreeDeletion } from "@/store/worktreeDeletions";
import type { Worktree } from "@shared/types";

interface WorktreeRowProps {
  worktree: Worktree;
}

export function WorktreeRow({ worktree }: WorktreeRowProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const deletionPhase = useWorktreeDeletion(worktree.id);
  const activity = useWorktreeScriptActivity(worktree.id);
  const expectedPath = `/projects/${encodeURIComponent(worktree.projectId)}/worktrees/${encodeURIComponent(worktree.name)}`;
  const isSelected = location.pathname === expectedPath;
  const deleting = deletionPhase !== undefined;

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
      title={describeRow(worktree, deletionPhase, activity)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
        "hover:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
        deletionPhase === "removing" && "opacity-50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate font-mono", isSelected && "font-medium")}>
          {worktree.branch}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {worktree.name}
        </span>
      </div>
      {deleting && deletionPhase === "removing" ? (
        <Loader2
          className="size-3 shrink-0 animate-spin text-muted-foreground"
          aria-label="Removing"
        />
      ) : activity || deleting ? (
        <ActivityIcon kind={deleting ? "teardown" : activity!} />
      ) : (
        <>
          {worktree.isPrimary && (
            <House
              className="size-3 text-muted-foreground/60"
              aria-label="Repo root"
            />
          )}
          {!worktree.isPrimary && worktree.isExternal && (
            <ExternalLink
              className="size-3 text-muted-foreground/60"
              aria-label="External worktree"
            />
          )}
          <StatusIndicator worktree={worktree} />
        </>
      )}
    </button>
  );
}

function describeRow(
  worktree: Worktree,
  deletionPhase: "tearingDown" | "removing" | undefined,
  activity: ScriptActivityKind | null,
): string | undefined {
  if (deletionPhase === "tearingDown") return "Tearing down…";
  if (deletionPhase === "removing") return "Removing…";
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
  const parts: string[] = [];
  if (worktree.ahead > 0) parts.push(`↑${worktree.ahead}`);
  if (worktree.behind > 0) parts.push(`↓${worktree.behind}`);
  if (worktree.changedCount > 0) parts.push(`●${worktree.changedCount}`);

  if (parts.length === 0) {
    return null;
  }

  return (
    <span className="tabular text-[10px] text-muted-foreground">
      {parts.join(" ")}
    </span>
  );
}
