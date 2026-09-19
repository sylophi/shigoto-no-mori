import { SubPageNotFound } from "@/components/shared/SubPageNotFound";

// The shared "resolve a worktree out of the list query" fallback.
// Pending renders nothing. On a cold cache (e.g. a reload landing
// directly on the route) absence doesn't mean missing. A failed list
// gets an error with a retry, because the worktrees query is silent on
// error (the sidebar owns that toast) and would otherwise read as a
// deleted worktree. Only a resolved list may claim the target is gone.
export function WorktreeMissing({
  isPending,
  isError,
  refetch,
  onBack,
  message,
}: {
  isPending: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
  onBack: () => void;
  message: string;
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
  return <SubPageNotFound onBack={onBack} message={message} />;
}
