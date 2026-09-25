import { SubPageNotFound } from "@/components/shared/SubPageNotFound";
import { WORKTREE_DELETED_MESSAGE } from "@/hooks/worktrees/useWorktreeWasDeleted";

// The shared "resolve a worktree out of the list query" fallback.
// Pending renders nothing. On a cold cache (e.g. a reload landing
// directly on the route) absence doesn't mean missing. A failed list
// gets an error with a retry, because the worktrees query is silent on
// error (the sidebar owns that toast) and would otherwise read as a
// deleted worktree. Only a resolved list may claim the target is gone,
// and one that dropped it while the page was open says it was deleted.
export function WorktreeMissing({
  isPending,
  isError,
  deleted,
  refetch,
  onBack,
  message = "Worktree not found.",
}: {
  isPending: boolean;
  isError: boolean;
  deleted: boolean;
  refetch: () => Promise<unknown>;
  onBack: () => void;
  message?: string;
}) {
  if (isPending) return null;
  if (isError) {
    return (
      <SubPageNotFound
        onBack={onBack}
        message="Couldn't load worktrees."
        action={{ label: "Retry", onClick: () => void refetch() }}
      />
    );
  }
  return (
    <SubPageNotFound
      onBack={onBack}
      message={deleted ? WORKTREE_DELETED_MESSAGE : message}
    />
  );
}
