import { Archive } from "lucide-react";
import { RelativeDate } from "@/components/ui/relative-date";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

// The stashes made on the branch, at the foot of the Git page's Changes
// tab above the commit box, as GitHub Desktop keeps its stashed
// changes. Picking one shows what it holds beside the changes, with its
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
  if (stashes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 px-1.5 py-1.5">
      {stashes.map((stash) => {
        const picked = stash.hash === selected;
        return (
          <li key={stash.hash}>
            <button
              type="button"
              aria-current={picked || undefined}
              onClick={() =>
                nav.toDiff(worktree.projectId, worktree.id, {
                  stash: stash.hash,
                  replace: true,
                })
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                picked
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Archive aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {stash.named ? stash.message : "Stashed changes"}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                <RelativeDate date={stash.date} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
