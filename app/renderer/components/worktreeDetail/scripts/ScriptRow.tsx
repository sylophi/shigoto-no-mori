import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { ScriptSlot } from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";
import { ScriptStatusBadge } from "@/components/shared/ScriptStatusBadge";
import { ScriptRowView } from "./ScriptRowView";

interface ScriptRowProps {
  worktree: Worktree;
  slot: ScriptSlot;
  label: string;
  command: string;
}

export function ScriptRow({ worktree, slot, label, command }: ScriptRowProps) {
  const { toScript } = useWorktreeNav();
  // The runner also says whether a run can be dispatched from here (a
  // peer that has not granted control refuses commands) and why.
  const { state, busy, canRun, disabledReason, start, stop } = useScriptRunner(
    worktree,
    slot,
  );
  // No history means there's nothing for the console to show, so the
  // right-side "view output" affordance only appears once a run lands.
  const hasHistory = state.status !== "idle";

  return (
    <ScriptRowView
      label={label}
      command={command}
      busy={busy}
      disabled={state.cancelling || !canRun}
      disabledReason={disabledReason}
      status={hasHistory ? <ScriptStatusBadge state={state} /> : null}
      onToggle={busy ? stop : start}
      onOpenConsole={() => toScript(worktree.projectId, worktree.id, slot)}
    />
  );
}
