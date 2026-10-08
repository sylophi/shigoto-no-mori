import { Archive, ArchiveRestore, Copy, Ellipsis, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RelativeDate } from "@/components/ui/relative-date";
import {
  useApplyStash,
  useDropStash,
  useRestoreStash,
  useWorktreeStashes,
} from "@/hooks/worktrees/useGitHistory";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { StashEntry, Worktree } from "@shared/schemas";

// The stashes made on this worktree's branch, under its commits. Restore
// puts the changes back and drops the stash once they applied cleanly.
export function StashRows({ worktree }: { worktree: Worktree }) {
  const { data: stashes } = useWorktreeStashes(worktree);
  const apply = useApplyStash();
  const drop = useDropStash();
  const restore = useRestoreStash();
  if (!stashes || stashes.length === 0) return null;
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = apply.isPending || drop.isPending;

  const onDrop = (stash: StashEntry) =>
    drop.mutate(
      { ...scope, hash: stash.hash },
      {
        onSuccess: () =>
          toast("Dropped the stash", {
            duration: UNDO_TOAST_MS,
            action: {
              label: "Undo",
              onClick: () =>
                restore.mutate({
                  ...scope,
                  hash: stash.hash,
                  message: stash.message,
                  named: stash.named,
                }),
            },
          }),
      },
    );

  return (
    <ul className="space-y-1">
      {stashes.map((stash) => (
        <li
          key={stash.hash}
          className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm"
        >
          <Archive
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate">
            {stash.named ? (
              <>
                <span className="text-muted-foreground">Stashed </span>
                {stash.message}
              </>
            ) : (
              <>
                Stashed changes
                <span className="text-muted-foreground">
                  {" "}
                  on top of {stash.message}
                </span>
              </>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <RelativeDate date={stash.date} />
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              apply.mutate({ ...scope, hash: stash.hash, drop: true })
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <ArchiveRestore aria-hidden className="size-3.5" />
            Restore
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Stash actions"
              disabled={busy}
              data-icon-button
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 data-popup-open:bg-accent data-popup-open:text-foreground"
            >
              <Ellipsis aria-hidden className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={4}
              className="min-w-44"
            >
              <DropdownMenuItem
                onClick={() =>
                  apply.mutate({ ...scope, hash: stash.hash, drop: false })
                }
              >
                <ArchiveRestore />
                Restore and keep the stash
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void navigator.clipboard.writeText(stash.hash)}
              >
                <Copy />
                Copy hash
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDrop(stash)}
              >
                <Trash2 />
                Drop
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      ))}
    </ul>
  );
}
