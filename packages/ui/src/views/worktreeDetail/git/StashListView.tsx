import { Archive } from "lucide-react";
import { Button } from "../../../primitives/button.tsx";
import { Input } from "../../../primitives/input.tsx";
import { RelativeDate } from "../../../primitives/relative-date.tsx";
import { cn } from "../../../lib/utils.ts";
import type { StashEntry } from "@shigomori/contracts/schemas/index";

// The Git page's Stashes tab: the way to stash the uncommitted changes
// (with a name, if they deserve one), then the stashes made on the
// branch, newest first. Picking one shows what it holds beside the
// list, with its moves there. A new stash is picked as it lands. A peer
// that takes no commands from here only lists them (StashList binds it).
export function StashListView({
  stashes,
  selected,
  changedCount,
  canCommand,
  message,
  onMessageChange,
  pending,
  onSubmit,
  onPick,
}: {
  stashes: readonly StashEntry[];
  // The stash shown beside the list, by hash.
  selected: string | undefined;
  // The uncommitted files a stash would take.
  changedCount: number;
  canCommand: boolean;
  // The new stash's name, and the stash under way.
  message: string;
  onMessageChange: (message: string) => void;
  pending: boolean;
  onSubmit: () => void;
  onPick: (hash: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canCommand && (
        <form
          className="flex items-center gap-1.5 px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Input
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            placeholder="Name (optional)"
            aria-label="Stash name"
            disabled={changedCount === 0 || pending}
            className="min-w-0 flex-1 px-2.5 py-1.5 text-xs"
          />
          <Button
            type="submit"
            size="sm"
            disabled={changedCount === 0 || pending}
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
                onClick={() => onPick(stash.hash)}
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
                  <span className="block truncate text-xs">
                    {stash.named ? stash.message : "Stashed changes"}
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">
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
