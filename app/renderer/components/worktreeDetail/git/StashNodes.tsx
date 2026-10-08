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
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { cn } from "@/lib/utils";
import { TimelineRow, useRowSelection, useTimelineView } from "./TimelineRow";

// A stash made on this branch: work set aside, so it sits on the
// timeline just under the working tree it came from. The row opens its
// contents, and Restore puts it back and drops it once it applied
// cleanly.
export function StashNode({
  worktree,
  stash,
}: {
  worktree: Worktree;
  stash: StashEntry;
}) {
  const nav = useWorktreeNav();
  const { onGitPage } = useTimelineView();
  const { selected, expanded } = useRowSelection(`stash:${stash.hash}`);
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
      <div
        className={cn(
          "-mx-1.5 flex items-start gap-1 rounded-md transition-colors",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
      >
        {/* Its message over its age in a column (the Git page's
            sidebar), one line where the timeline is wide. */}
        <button
          type="button"
          aria-current={selected || undefined}
          onClick={() =>
            nav.toStash(worktree.projectId, worktree.id, stash.hash, onGitPage)
          }
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring @md/timeline:flex-row @md/timeline:items-center @md/timeline:gap-3"
        >
          <span className="w-full truncate text-sm @md/timeline:w-auto @md/timeline:min-w-0 @md/timeline:flex-1">
            {stash.named ? (
              <>
                <span className="text-muted-foreground">Stashed </span>
                {stash.message}
              </>
            ) : (
              <>
                Stashed changes
                <span className="text-muted-foreground @max-md/timeline:hidden">
                  {" "}
                  on top of {stash.message}
                </span>
              </>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <RelativeDate date={stash.date} />
          </span>
        </button>
        <SimpleTooltip tip="Restore">
          <Button
            variant="ghost"
            size="xs"
            aria-label="Restore"
            className="mt-1"
            disabled={busy}
            onClick={() =>
              apply.mutate({ ...scope, hash: stash.hash, drop: true })
            }
          >
            <ArchiveRestore />
            <span className="@max-md/timeline:hidden">Restore</span>
          </Button>
        </SimpleTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Stash actions"
            disabled={busy}
            data-icon-button
            className="mt-1 mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 data-popup-open:bg-accent data-popup-open:text-foreground"
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
      {expanded}
    </TimelineRow>
  );
}
