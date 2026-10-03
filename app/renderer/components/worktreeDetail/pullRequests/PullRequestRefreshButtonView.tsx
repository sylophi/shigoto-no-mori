import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Re-asks gh for the PR (PullRequestRefreshButton). The icon spins
// through any refetch.
export function PullRequestRefreshButtonView({
  spinning = false,
  onClick,
}: {
  spinning?: boolean;
  onClick?: () => void;
}) {
  return (
    <SimpleTooltip tip="Refresh pull request">
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Refresh pull request"
        className="-my-1 text-muted-foreground/70 hover:text-foreground"
        onClick={onClick}
      >
        <RefreshCw aria-hidden className={cn(spinning && "animate-spin")} />
      </Button>
    </SimpleTooltip>
  );
}
