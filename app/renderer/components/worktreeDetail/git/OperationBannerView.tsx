import { ChevronRight, TriangleAlert } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { pluralize } from "@shigomori/ui/lib/pluralize.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import type { GitOperationState } from "@shigomori/contracts/schemas";

const STOPPED: Record<string, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  squash: "Squash",
  "git am": "git am",
  bisect: "Bisect",
  "cherry-pick or revert": "Cherry-pick",
};

// A merge, rebase, squash, cherry-pick or revert the worktree is
// stopped in, from the app or a terminal, or conflicts a stash left
// behind. Shown on the worktree page's Git section, where Resolve leads
// to the Git page, and atop the Git page's Changes tab, where the
// conflicted files are settled. Once none is left, the operation can be
// continued. Nothing while the worktree is in none. Only says, on a peer
// that takes no commands from here (OperationBanner binds it).
export function OperationBannerView({
  state,
  onGitPage = false,
  canCommand,
  busy,
  onAbort,
  onContinue,
  onResolve,
}: {
  state: GitOperationState | undefined;
  onGitPage?: boolean;
  canCommand: boolean;
  // An abort or a continue is under way.
  busy: boolean;
  onAbort: () => void;
  onContinue: () => void;
  onResolve: () => void;
}) {
  if (!state || (state.operation === null && state.conflicted === 0)) {
    return null;
  }
  const title =
    state.operation === null
      ? "Conflicts in the working tree"
      : `${STOPPED[state.operation] ?? state.operation} stopped`;
  const detail =
    state.conflicted > 0
      ? `${pluralize(state.conflicted, "file")} to resolve`
      : "every conflict resolved";
  // On the Git page's narrow sidebar the detail drops under the title
  // and the moves stay beside them, two lines in all.
  return (
    <div
      className={cn(
        "flex items-center rounded-lg bg-amber-500/10",
        onGitPage
          ? "gap-2 px-2 py-1.5 text-xs"
          : "flex-wrap gap-x-3 gap-y-1.5 px-3 py-2 text-sm",
      )}
    >
      <TriangleAlert
        aria-hidden
        className={cn(
          "shrink-0 text-amber-500",
          onGitPage ? "size-3.5" : "size-4",
        )}
      />
      <div className={cn("min-w-0 flex-1", !onGitPage && "basis-40")}>
        {onGitPage ? (
          <>
            <div className="truncate">{title}</div>
            <div className="truncate text-muted-foreground">{detail}</div>
          </>
        ) : (
          <>
            {title}
            <span className="ml-2 text-muted-foreground">{detail}</span>
          </>
        )}
      </div>
      {canCommand && (
        <div className="flex shrink-0 items-center gap-1">
          {state.operation !== null && (
            <Button variant="ghost" size="xs" disabled={busy} onClick={onAbort}>
              Abort
            </Button>
          )}
          {state.conflicted === 0
            ? state.continuable && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={onContinue}
                >
                  Continue
                </Button>
              )
            : !onGitPage && (
                <Button variant="outline" size="xs" onClick={onResolve}>
                  Resolve
                  <ChevronRight />
                </Button>
              )}
        </div>
      )}
    </div>
  );
}
