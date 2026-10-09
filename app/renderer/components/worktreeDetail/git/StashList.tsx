import { useState } from "react";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RelativeDate } from "@/components/ui/relative-date";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import {
  useStashChanges,
  useWorktreeStashes,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

// The Git page's Stashes tab: the way to stash the uncommitted changes
// (with a name, if they deserve one), then the stashes made on the
// branch, newest first. Picking one shows what it holds beside the
// list, with its moves there. A new stash is picked as it lands. A peer
// that takes no commands from here only lists them.
export function StashList({
  worktree,
  selected,
}: {
  worktree: Worktree;
  selected: string | undefined;
}) {
  const nav = useWorktreeNav();
  const { data: stashes = [], refetch } = useWorktreeStashes(worktree);
  const stashChanges = useStashChanges();
  const say = useWorktreeSuccessToast();
  const { canCommand } = useCommandAccess();
  const [message, setMessage] = useState("");
  const { projectId, id: worktreeId, changedCount } = worktree;
  const submit = () => {
    if (changedCount === 0 || stashChanges.isPending) return;
    stashChanges.mutate(
      { projectId, worktreeId, message: message.trim() || undefined },
      {
        onSuccess: async () => {
          setMessage("");
          say(worktree, `Stashed ${pluralize(changedCount, "file")}`);
          const { data } = await refetch();
          const newest = data?.[0]?.hash;
          if (newest) nav.toStash(projectId, worktreeId, newest, true);
        },
      },
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canCommand && (
        <form
          className="flex items-center gap-1.5 px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Name (optional)"
            aria-label="Stash name"
            disabled={changedCount === 0 || stashChanges.isPending}
            className="min-w-0 flex-1 px-2.5 py-1.5 text-xs"
          />
          <Button
            type="submit"
            size="sm"
            disabled={changedCount === 0 || stashChanges.isPending}
          >
            <Archive />
            Stash
          </Button>
        </form>
      )}
      {stashes.length === 0 && (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          {changedCount > 0 || !canCommand
            ? "No stashes yet"
            : "Nothing to stash"}
        </p>
      )}
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
                    <RelativeDate date={stash.date} />
                    {!stash.named && `, on top of ${stash.message}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
