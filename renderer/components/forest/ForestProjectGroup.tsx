import type { RowStatus } from "@/components/ui/row-status";
import { ProjectIcon } from "@/components/sidebar/ProjectIcon";
import { ForestSurveyRow, ForestTidyRow } from "./ForestRow";
import type { ForestGroup } from "./useForestRows";

// Everything the rows need while tidying, absent entirely while
// surveying. Passing it as one optional object rather than four inert
// props is how the group says which mode it is in.
export interface ForestTidyState {
  selected: ReadonlySet<string>;
  status: Map<string, RowStatus>;
  disabled: boolean;
  onToggle: (worktreeId: string) => void;
}

interface ForestProjectGroupProps {
  group: ForestGroup;
  tidy: ForestTidyState | undefined;
}

// A project and its worktrees. The heading is a quiet label rather than
// a SectionHeading: project names are proper nouns and shouldn't be
// upper-cased, and the whitespace between groups is doing the real
// separating work.
export function ForestProjectGroup({ group, tidy }: ForestProjectGroupProps) {
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
      <div className="overflow-hidden rounded-md border border-border bg-card">
        {group.entries.map((entry, index) =>
          tidy ? (
            <ForestTidyRow
              key={entry.worktree.id}
              entry={entry}
              checked={tidy.selected.has(entry.worktree.id)}
              status={tidy.status.get(entry.worktree.id) ?? { kind: "idle" }}
              disabled={tidy.disabled}
              onToggle={() => tidy.onToggle(entry.worktree.id)}
              isLast={index === group.entries.length - 1}
            />
          ) : (
            <ForestSurveyRow
              key={entry.worktree.id}
              entry={entry}
              isLast={index === group.entries.length - 1}
            />
          ),
        )}
      </div>
    </section>
  );
}
