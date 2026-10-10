import { RefreshCw } from "lucide-react";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

// The page's one refresh, in the header's top row. It spins through
// whatever the page is waiting on (a ref fetch, the worktree or branch
// lists, the PR), the automatic ones included, and says which in its
// tooltip (idle, the icon says enough). A click fetches the project's
// refs, as opening the page does and only on this device, and re-asks
// GitHub for the PR: the page refetches on focus and when refs move,
// but checks finishing or mergeability moving on GitHub's side reach
// none of that. Always there, so nothing beside it in the row moves
// when it starts or stops.
export function WorktreeActivityIndicatorView({
  tip,
  spinning,
  onRefresh,
}: {
  // What the page is waiting on, while it spins.
  tip: string | null;
  spinning: boolean;
  onRefresh: () => void;
}) {
  return (
    <SimpleTooltip tip={tip}>
      <IconButton
        onClick={onRefresh}
        aria-label={tip ?? "Refresh"}
        className="-my-1 text-muted-foreground/70"
      >
        <RefreshCw
          aria-hidden
          className={cn("size-3.5", spinning && "animate-spin")}
        />
      </IconButton>
    </SimpleTooltip>
  );
}
