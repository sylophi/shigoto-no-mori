import { Archive, ArchiveRestore, Copy, Ellipsis, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
} from "@/hooks/worktrees/useGitHistory";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { StashEntry, Worktree } from "@shared/schemas";
import { TimelineRow } from "./TimelineRow";

// A stash made on this branch: work set aside, so it sits on the
// timeline just under the working tree it came from. Restore puts it
// back and drops it once it applied cleanly.
export function StashNode({
  worktree,
  stash,
}: {
  worktree: Worktree;
  stash: StashEntry;
}) {
  const apply = useApplyStash();
  const drop = useDropStash();
  const restore = useRestoreStash();
  const scope = { projectId: worktree.projectId, worktreeId: worktree.id };
  const busy = apply.isPending || drop.isPending;

  const onDrop = () =>
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
    <TimelineRow
      node={<Archive aria-hidden className="size-3.5 text-muted-foreground" />}
    >
      <div className="group/stash flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate py-1.5 text-sm">
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
        </div>
        <span className="shrink-0 text-xs text-muted-foreground phone:hidden">
          <RelativeDate date={stash.date} />
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() =>
            apply.mutate({ ...scope, hash: stash.hash, drop: true })
          }
        >
          <ArchiveRestore />
          Restore
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Stash actions"
            disabled={busy}
            data-icon-button
            className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 data-popup-open:bg-accent data-popup-open:text-foreground"
          >
            <Ellipsis aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
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
            <DropdownMenuItem variant="destructive" onClick={onDrop}>
              <Trash2 />
              Drop
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TimelineRow>
  );
}
