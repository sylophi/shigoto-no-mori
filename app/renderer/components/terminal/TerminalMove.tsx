import type { Worktree } from "@shigomori/contracts/schemas";
import { worktreeName } from "@shigomori/ui/lib/worktreeTitle.ts";
import { TerminalMoveView } from "@shigomori/ui/views/terminal/TerminalMoveView.tsx";
import { TerminalTabToolbar } from "@shigomori/ui/views/terminal/TerminalTabsView.tsx";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { notifyError } from "@/lib/toast";

// The picked terminal's move to another of its project's worktrees, in
// the tab row while there is another.
export function TerminalMove({
  worktree,
  terminalId,
  onMoved,
}: {
  worktree: Worktree;
  terminalId: string;
  onMoved: (worktreeId: string) => void;
}) {
  const { api } = useHostScope();
  const prs = useProjectPullRequests(worktree.projectId).data;
  const targets = (useWorktrees(worktree.projectId).data ?? [])
    .filter((other) => other.id !== worktree.id)
    .map((other) => ({
      id: other.id,
      label: worktreeName(other, prs),
      name: other.name,
    }));
  if (targets.length === 0) return null;
  return (
    <TerminalTabToolbar>
      <TerminalMoveView
        targets={targets}
        onMove={(worktreeId) =>
          void api
            .run(api.terminals.move({ terminalId, worktreeId }))
            .then(() => onMoved(worktreeId))
            .catch((error: unknown) =>
              notifyError("Couldn't move the terminal", error),
            )
        }
      />
    </TerminalTabToolbar>
  );
}
