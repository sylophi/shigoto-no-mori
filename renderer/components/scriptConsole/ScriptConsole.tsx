import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { DiffNotFound } from "@/components/diff/DiffNotFound";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { paramToSlot } from "@/store/scriptRuns";
import { ScriptConsoleInner } from "./ScriptConsoleInner";

const route = getRouteApi(
  "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
);

export function ScriptConsole() {
  const { projectId, worktreeId, scriptKey: rawKey } = route.useParams();
  const navigate = useNavigate();
  const {
    data: worktrees = [],
    isPending,
    isError,
    refetch,
  } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);
  const slot = paramToSlot(rawKey);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId",
      params: { projectId, worktreeId },
    });

  if (!worktree || !slot) {
    // Cold cache (e.g. a reload landing directly on this route): the
    // list hasn't resolved yet, so absence doesn't mean missing.
    if (!worktree && isPending) return null;
    // The list query is silent on error, so without this branch a
    // failed listing reads as a vanished script -- possibly one that
    // is still running fine.
    if (!worktree && isError) {
      return (
        <DiffNotFound
          onBack={goBack}
          message="Couldn't load worktrees."
          action={{ label: "Retry", onClick: () => void refetch() }}
        />
      );
    }
    return <DiffNotFound onBack={goBack} message="Script not found." />;
  }

  return <ScriptConsoleInner worktree={worktree} slot={slot} onBack={goBack} />;
}
