// The worktree page's Ports section: the worktree's ports (PortList),
// between the branch and the scripts. Gone when there is nothing to
// show and nothing to add: no ports on a worktree the viewer cannot
// edit.
import type { Worktree } from "@shared/schemas";
import { SectionHeading } from "@/components/ui/section-heading";
import { PortActions, PortList, usePortList } from "./PortList";

export function PortsSection({ worktree }: { worktree: Worktree }) {
  const state = usePortList(worktree);
  if (!state.canEdit && !state.isPending && state.ports.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      {/* Held at the heading's height: the actions overhang it, so the
          rows don't shift when one appears. */}
      <div className="flex h-4 items-center justify-between gap-2">
        <SectionHeading>Ports</SectionHeading>
        <div className="-mr-2 flex items-center gap-1">
          <PortActions state={state} />
        </div>
      </div>
      <PortList state={state} plain />
    </section>
  );
}
