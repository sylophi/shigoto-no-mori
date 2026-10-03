// The Pull request section as drawn (PullRequestSection.tsx reads the
// PR): the heading with its refresh button, over the body, which
// stacks the identity (PullRequestIdentityView), the stack list
// (StackList) and the box for what is next (MergeBoxView or
// ClosedPullRequestBoxView).
import type { ReactNode } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import { PullRequestRefreshButtonView } from "./PullRequestRefreshButtonView";

export function PullRequestSectionView({
  refresh,
  children,
}: {
  // The refresh button, PullRequestRefreshButtonView at rest when not
  // given.
  refresh?: ReactNode;
  // The body's parts, absent while a PR the sidebar knows of loads.
  children?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1">
        <SectionHeading>Pull request</SectionHeading>
        {refresh ?? <PullRequestRefreshButtonView />}
      </div>
      {children && <div className="space-y-4">{children}</div>}
    </section>
  );
}
