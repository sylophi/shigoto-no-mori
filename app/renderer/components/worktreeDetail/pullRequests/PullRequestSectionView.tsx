// The worktree's PR as a section of the page (PullRequestSection binds
// it), for work the PR doesn't name: its identity, its stack, and what
// to do about it. Held in place under its heading while the PR the
// project's map knows of is looked up.
import type { ReactNode } from "react";
import { SectionHeading } from "@/components/ui/section-heading";

export function PullRequestSectionView({
  identity,
  stackList,
  body,
}: {
  // The PR's identity (PullRequestIdentity), its stack (StackListView)
  // and what to do about it (PullRequestBody), once it's read.
  identity?: ReactNode;
  stackList?: ReactNode;
  body?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading>Pull request</SectionHeading>
      {identity && (
        <div className="space-y-4">
          {identity}
          {stackList}
          {body}
        </div>
      )}
    </section>
  );
}
