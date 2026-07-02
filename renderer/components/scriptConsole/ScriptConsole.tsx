import { useNavigate } from "@tanstack/react-router";
import { BackButton } from "@/components/ui/back-button";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { paramToSlot } from "@/store/scriptRuns";
import { scriptConsoleRoute } from "@/router";
import { ScriptConsoleInner } from "./ScriptConsoleInner";

export function ScriptConsole() {
  const {
    projectId,
    worktreeId,
    scriptKey: rawKey,
  } = scriptConsoleRoute.useParams();
  const navigate = useNavigate();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);
  const slot = paramToSlot(rawKey);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });

  if (!worktree || !slot) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-border px-6 pt-7 pb-4">
          <BackButton onClick={goBack} label="Back" />
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Script not found.
        </div>
      </div>
    );
  }

  return <ScriptConsoleInner worktree={worktree} slot={slot} onBack={goBack} />;
}
