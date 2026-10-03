// The Pull request section as drawn (PullRequestSection.tsx reads the
// PR): the heading with its refresh button, over the body, which
// stacks the identity (PullRequestIdentityView), the stack list
// (StackList) and the box for what is next (MergeBoxView or
// ClosedPullRequestBoxView).
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function PullRequestSectionView({
  refresh,
  children,
}: {
  // The refresh button, PullRequestRefreshButtonView at rest when not
  // given.
  refresh?: ReactNode;
  // The body, absent while a PR the sidebar knows of loads.
  children?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1">
        <SectionHeading>Pull request</SectionHeading>
        {refresh ?? <PullRequestRefreshButtonView />}
      </div>
      {children}
    </section>
  );
}

export function PullRequestBodyView({ children }: { children: ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}

// Re-asks gh for the PR. The icon spins through any refetch.
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
