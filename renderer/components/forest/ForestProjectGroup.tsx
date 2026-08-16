import { ProjectIcon } from "@/components/sidebar/ProjectIcon";
import { ForestWorktreeCard } from "./ForestWorktreeCard";
import type { ForestGroup } from "./useForestRows";

interface ForestProjectGroupProps {
  group: ForestGroup;
}

// A project and its worktrees. The heading is a quiet label rather than
// a SectionHeading: project names are proper nouns and shouldn't be
// upper-cased, and the whitespace between groups is doing the real
// separating work.
export function ForestProjectGroup({ group }: ForestProjectGroupProps) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <ProjectIcon projectId={group.project.id} />
        <h2 className="min-w-0 truncate text-xs font-medium">
          {group.project.name}
        </h2>
        <span className="tabular text-[10px] text-muted-foreground">
          {group.entries.length}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {group.entries.map((entry) => (
          <ForestWorktreeCard key={entry.worktree.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
