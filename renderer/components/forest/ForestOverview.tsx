import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { sortProjects } from "@/components/sidebar/sortProjects";
import {
  useForestSort,
  useSetForestSort,
} from "@/hooks/projects/useForestSort";
import { useProjects } from "@/hooks/projects/useProjects";
import { useProjectSort } from "@/hooks/projects/useProjectSort";
import { useOverlays } from "@/hooks/ui/useOverlays";
import type { ForestFacet } from "./forestFilters";
import { ForestProjectGroup } from "./ForestProjectGroup";
import { ForestToolbar } from "./ForestToolbar";
import { useForestRows } from "./useForestRows";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The whole forest on one screen: every worktree of every project,
// grouped by project, dense enough that ten of them fit in a glance.
// Project groups follow the sidebar's own project order so the two
// surfaces stay recognizably the same forest.
export function ForestOverview() {
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: projectSort = "manual" } = useProjectSort();
  const { openAddProject } = useOverlays();
  // Sort persists -- it's how you like to read the forest. The facet and
  // the text filter are transient triage state, so they reset on every
  // visit rather than greeting you with a filtered forest you forgot you
  // set.
  const sort = useForestSort();
  const setSort = useSetForestSort();
  const [facet, setFacet] = useState<ForestFacet>("all");
  const [query, setQuery] = useState("");

  const forest = useForestRows({
    projects: sortProjects(projects, projectSort),
    facet,
    sort,
    query,
  });

  const clearFilters = () => {
    setFacet("all");
    setQuery("");
  };

  if (projectsLoading) return null;
  if (projects.length === 0) {
    return (
      <CenteredMessage>
        No projects yet. Add one and the forest fills in.
      </CenteredMessage>
    );
  }

  const narrowed = facet !== "all" || query !== "";
  // While a project is still answering, every total on screen is
  // provisional -- say so rather than showing a number that's about to
  // jump.
  const summary = forest.isLoading
    ? "Counting the forest…"
    : narrowed
      ? `${forest.shown} of ${plural(forest.total, "worktree")}`
      : `${plural(forest.total, "worktree")} across ${plural(forest.plantedProjects, "project")}`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {summary}
          </span>
          <h1 className="text-lg font-medium tracking-tight">The forest</h1>
        </div>
        <ForestToolbar
          facet={facet}
          onFacetChange={setFacet}
          sort={sort}
          onSortChange={(next) => setSort.mutate(next)}
          query={query}
          onQueryChange={setQuery}
          counts={forest.counts}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-4xl flex-col gap-8">
          {forest.failedCount > 0 && (
            <ErrorBanner>
              Couldn't read worktrees for{" "}
              {plural(forest.failedCount, "project")}.
            </ErrorBanner>
          )}

          {forest.groups.length === 0 ? (
            <EmptyResult
              loading={forest.isLoading}
              narrowed={narrowed}
              onClear={clearFilters}
              onAddProject={openAddProject}
            />
          ) : (
            forest.groups.map((group) => (
              <ForestProjectGroup key={group.project.id} group={group} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface EmptyResultProps {
  loading: boolean;
  narrowed: boolean;
  onClear: () => void;
  onAddProject: () => void;
}

function EmptyResult({
  loading,
  narrowed,
  onClear,
  onAddProject,
}: EmptyResultProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (narrowed) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          No worktrees match this filter.
        </p>
        <Button size="xs" variant="outline" onClick={onClear}>
          Clear
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <p className="text-sm text-muted-foreground">
        No worktrees in any project yet.
      </p>
      <Button size="xs" variant="outline" onClick={onAddProject}>
        Add a project
      </Button>
    </div>
  );
}
