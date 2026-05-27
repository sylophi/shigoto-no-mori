import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Play, Square } from "lucide-react";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { cn } from "@/lib/utils";
import { slotToParam, type ScriptSlot } from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";
import { ScriptStatusBadge } from "./ScriptStatusBadge";

interface ScriptRowProps {
  worktree: Worktree;
  slot: ScriptSlot;
  label: string;
  command: string;
  isLast: boolean;
}

export function ScriptRow({
  worktree,
  slot,
  label,
  command,
  isLast,
}: ScriptRowProps) {
  const navigate = useNavigate();
  const { state, busy, start, stop } = useScriptRunner(worktree, slot);
  // No history means there's nothing for the console to show, so the
  // right-side "view output" affordance only appears once a run lands.
  const hasHistory = state.status !== "idle";

  const openConsole = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
      params: {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        scriptKey: slotToParam(slot),
      },
    });

  const actionLabel = busy ? `Stop ${label}` : `Run ${label}`;

  return (
    <div
      className={cn(
        "flex items-stretch text-xs",
        !isLast && "border-b border-border",
      )}
    >
      <button
        type="button"
        onClick={busy ? stop : start}
        disabled={state.cancelling}
        aria-label={actionLabel}
        title={command ? `${actionLabel}\n${command}` : actionLabel}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          busy ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent",
        )}
      >
        {busy ? (
          <Square aria-hidden className="size-3 shrink-0" />
        ) : (
          <Play aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      </button>

      {hasHistory && (
        <button
          type="button"
          onClick={openConsole}
          aria-label={`View ${label} output`}
          title="View output"
          className="flex shrink-0 items-center gap-2 border-l border-border px-2.5 py-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <ScriptStatusBadge state={state} />
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        </button>
      )}
    </div>
  );
}
