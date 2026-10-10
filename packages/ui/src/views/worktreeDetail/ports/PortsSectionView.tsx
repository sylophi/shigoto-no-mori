// The worktree page's Ports section (PortsSection binds it): the
// worktree's ports, with their actions beside the heading.
import type { ReactNode } from "react";
import { SectionHeading } from "../../../primitives/section-heading.tsx";

export function PortsSectionView({
  actions,
  list,
}: {
  // The list's actions (PortActions) and the list (PortList).
  actions: ReactNode;
  list: ReactNode;
}) {
  return (
    <section className="space-y-3">
      {/* Held at the heading's height: the actions overhang it, so the
          rows don't shift when one appears. */}
      <div className="flex h-4 items-center justify-between gap-2">
        <SectionHeading>Ports</SectionHeading>
        <div className="-mr-2 flex items-center gap-1">{actions}</div>
      </div>
      {list}
    </section>
  );
}
