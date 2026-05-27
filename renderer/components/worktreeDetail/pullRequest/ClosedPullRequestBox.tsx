import { Loader2, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

export function ClosedPullRequestBox({ worktree }: { worktree: Worktree }) {
  const navigate = useNavigate();
  const { data: siblings = [] } = useWorktrees(worktree.projectId);
  const deleteMutation = useDeleteWorktree();
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);
  const busy = deleteMutation.isPending;

  const runDelete = () => {
    deleteMutation.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id },
      {
        onSuccess: (data) => {
          if (!data.ok) return;
          // Prefer the sibling above so the user's eye stays in place.
          const index = siblings.findIndex((w) => w.id === worktree.id);
          const next =
            index >= 0
              ? (siblings[index - 1] ?? siblings[index + 1])
              : undefined;
          if (next) {
            void navigate({
              to: "/projects/$projectId/worktrees/$worktreeId",
              params: {
                projectId: worktree.projectId,
                worktreeId: next.id,
              },
              replace: true,
            });
          } else {
            void navigate({ to: "/", replace: true });
          }
        },
      },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => trigger(runDelete)}
          className={cn(
            "text-destructive hover:bg-destructive/10 hover:text-destructive",
            armed && "bg-destructive/10",
          )}
        >
          {busy ? (
            <>
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              Deleting…
            </>
          ) : armed ? (
            "Click again to confirm"
          ) : (
            <>
              <Trash2 aria-hidden className="size-3.5" />
              Delete worktree
            </>
          )}
        </Button>
      </div>
      {deleteMutation.error && (
        <ErrorBanner>{deleteMutation.error.message}</ErrorBanner>
      )}
    </div>
  );
}
