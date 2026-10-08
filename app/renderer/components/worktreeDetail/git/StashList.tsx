import { Archive } from "lucide-react";
import { RelativeDate } from "@/components/ui/relative-date";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

// The Git page's Stashes tab: the stashes made on the branch, newest
// first. Picking one shows what it holds beside the list, with its
// moves there.
export function StashList({
  worktree,
  selected,
}: {
  worktree: Worktree;
  selected: string | undefined;
}) {
  const nav = useWorktreeNav();
  const { data: stashes = [] } = useWorktreeStashes(worktree);
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3">
      {stashes.map((stash) => {
        const picked = stash.hash === selected;
        return (
          <li key={stash.hash}>
            <button
              type="button"
              aria-current={picked || undefined}
              onClick={() =>
                nav.toStash(worktree.projectId, worktree.id, stash.hash, true)
              }
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                picked
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50",
              )}
            >
              <Archive
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {stash.named ? stash.message : "Stashed changes"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {!stash.named && `On top of ${stash.message} · `}
                  <RelativeDate date={stash.date} />
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
