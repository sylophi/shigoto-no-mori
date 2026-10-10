// The worktree's remote-sync moves (WorktreeSyncPill binds them): a
// move held while something else runs, and the pick between two
// histories that diverged.
import { ArrowDown, ArrowUp, Ellipsis, GitMerge } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { SYNC_PILL_SHAPE, SyncActionButtonView } from "./SyncActionButtonView";

// A move that waits on something else (worktreeSyncView's `held`).
export function HeldSyncView({
  held,
  compact,
}: {
  held: {
    label: string;
    compactLabel?: string;
    tip?: string;
    Icon?: ComponentType<SVGProps<SVGSVGElement>>;
  };
  compact: boolean;
}) {
  return (
    <SimpleTooltip tip={held.tip}>
      <span className={cn(SYNC_PILL_SHAPE, "text-muted-foreground")}>
        {compact ? (held.compactLabel ?? held.label) : held.label}
        {held.Icon && <held.Icon aria-hidden className="size-3.5" />}
      </span>
    </SimpleTooltip>
  );
}

type SideMove = { armed: boolean; pending: boolean; onClick: () => void };

// Histories have diverged, and merging them conflicts. The merge `git
// pull` would make, stopped on its conflicts for the Changes tab to
// settle, or one side wins: "overwrite the remote" (force-push) or
// "overwrite local" (reset hard), both behind a two-step confirm.
export function PickSideView({
  ahead,
  behind,
  compact,
  busy,
  merge,
  pushForce,
  overwrite,
  onDisarm,
}: {
  ahead: number;
  behind: number;
  compact: boolean;
  // One of the three is under way.
  busy: boolean;
  merge: { pending: boolean; onClick: () => void };
  // Each a two-step confirm: armed by the first click.
  pushForce: SideMove;
  overwrite: SideMove;
  // Closing the menu disarms both, so a reopen never finds one a click
  // away from firing.
  onDisarm: () => void;
}) {
  const mergeButton = (
    <SyncActionButtonView
      tone="sky"
      icon={GitMerge}
      label={`Merge ${behind}`}
      tip="git pull --no-rebase, stopping on the conflicts for you to resolve"
      pending={merge.pending}
      disabled={busy}
      onClick={merge.onClick}
    />
  );
  // Narrow, the overwrites wait in a menu behind the merge, each still
  // confirmed with a second click.
  if (compact) {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 self-center text-xs">
        {mergeButton}
        {/* Closing the menu disarms both, so a reopen never finds one
            a click away from firing. */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (!open) onDisarm();
          }}
        >
          <DropdownMenuTrigger
            aria-label="Overwrite one side"
            disabled={busy}
            className="inline-flex size-6 items-center justify-center rounded-md text-rose-500 hover:bg-rose-500/10 focus-visible:outline-2 focus-visible:outline-rose-500 disabled:opacity-50"
          >
            <Ellipsis aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            <DropdownMenuItem
              variant="destructive"
              closeOnClick={pushForce.armed}
              onClick={(event) => {
                if (!pushForce.armed) event.preventDefault();
                pushForce.onClick();
              }}
            >
              <ArrowUp />
              {pushForce.armed
                ? "Click again to confirm"
                : `Push ${ahead}, overwriting the remote`}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              closeOnClick={overwrite.armed}
              onClick={(event) => {
                if (!overwrite.armed) event.preventDefault();
                overwrite.onClick();
              }}
            >
              <ArrowDown />
              {overwrite.armed
                ? "Click again to confirm"
                : `Pull ${behind}, overwriting this branch`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center text-xs">
      {mergeButton}
      {/* On the label, not the row: each button has its own tip, and
          two tooltips would stack. */}
      <SimpleTooltip
        tip={`Diverged: ${ahead} local, ${behind} remote. History has split. Pick which side wins.`}
      >
        <span className="px-1.5 text-rose-500">Overwrite:</span>
      </SimpleTooltip>
      <SyncActionButtonView
        tone="rose"
        icon={ArrowUp}
        label={pushForce.armed ? "Confirm?" : `Push ${ahead}`}
        tip={
          pushForce.armed
            ? undefined
            : "git push --force-with-lease (overwrites the remote)"
        }
        pending={pushForce.pending}
        disabled={busy}
        onClick={pushForce.onClick}
      />
      <SyncActionButtonView
        tone="rose"
        icon={ArrowDown}
        label={overwrite.armed ? "Confirm?" : `Pull ${behind}`}
        tip={
          overwrite.armed
            ? undefined
            : "git fetch && git reset --hard @{u} (overwrites local)"
        }
        pending={overwrite.pending}
        disabled={busy}
        onClick={overwrite.onClick}
      />
    </span>
  );
}
