// A script's row (ScriptRowView), run and stopped on the worktree's
// host, its output a click away.
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { ScriptSlot } from "@/store/scriptRuns";
import type { Worktree } from "@shigomori/contracts/schemas";
import { ScriptRowView } from "@shigomori/ui/views/worktreeDetail/scripts/ScriptRowView.tsx";

export function ScriptRow({
  worktree,
  slot,
  label,
  command,
}: {
  worktree: Worktree;
  slot: ScriptSlot;
  label: string;
  command: string;
}) {
  const { toScript } = useWorktreeNav();
  const { state, busy, canRun, disabledReason, start, stop } = useScriptRunner(
    worktree,
    slot,
  );
  return (
    <ScriptRowView
      label={label}
      command={command}
      state={state}
      busy={busy}
      canRun={canRun}
      disabledReason={disabledReason}
      onRun={start}
      onStop={stop}
      onOpenConsole={() => toScript(worktree.projectId, worktree.id, slot)}
    />
  );
}
