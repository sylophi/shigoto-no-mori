import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Trees } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { ErrorBanner } from "@/components/ui/error-banner";
import { sortProjects } from "@/components/sidebar/sortProjects";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import {
  useForestSort,
  useSetForestSort,
} from "@/hooks/projects/useForestSort";
import { useProjects } from "@/hooks/projects/useProjects";
import { useProjectSort } from "@/hooks/projects/useProjectSort";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { formatBytes } from "@/lib/formatBytes";
import { defaultSelection, summarize, type ForestFacet } from "./forestFilters";
import { ForestProjectGroup } from "./ForestProjectGroup";
import { ForestToolbar } from "./ForestToolbar";
import { TidyConfirm } from "./TidyConfirm";
import { TidyStat } from "./TidyStat";
import { useForestRows, type ForestData } from "./useForestRows";

const route = getRouteApi("/forest");

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The whole forest on one screen: every worktree of every project,
// grouped by project, dense enough that ten of them fit in a glance.
// Project groups follow the sidebar's own project order so the two
// surfaces stay recognizably the same forest.
//
// Surveying and tidying are the same screen because they are the same
// question asked twice. "What is the state of everything" and "what can
// I get rid of" read the same rows, and splitting them meant judging a
// worktree on one page and deleting it on another.
export function ForestOverview() {
  const { tidy: tidying, project: scopedProjectId } = route.useSearch();
  const navigate = useNavigate();
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: projectSort = "manual" } = useProjectSort();
  const { data: globalConfig } = useGlobalConfig();
  const { openAddProject } = useOverlays();
  // Sort persists. It's how you like to read the forest. The facet and
  // the text filter are transient triage state, so they reset on every
  // visit rather than greeting you with a filtered forest you forgot you
  // set.
  const sort = useForestSort();
  const setSort = useSetForestSort();
  const [facet, setFacet] = useState<ForestFacet>("all");
  const [query, setQuery] = useState("");
  // null means "you haven't touched the selection", so the safe-only
  // default keeps tracking the data as hygiene facts arrive. The first
  // toggle materializes it and from then on you are in charge.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { status, batchRunning, runBatch } = useSequentialBatch();
  const deleteWorktree = useDeleteWorktree();

  const scoped = scopedProjectId
    ? projects.filter((project) => project.id === scopedProjectId)
    : projects;
  const forest = useForestRows({
    projects: sortProjects(scoped, projectSort),
    facet,
    sort,
    query,
    measureDisk: tidying === true,
  });

  // Selection runs over the whole forest, not what's on screen. You
  // narrow the list to find things worth ticking, so a tick has to
  // survive the next keystroke -- and the batch has to remove what the
  // dialog listed rather than whatever the filter left visible.
  const selected = picked ?? defaultSelection(forest.all);
  const summary = summarize(forest.all, selected);
  const deleteBranches = globalConfig?.deleteBranchOnRemove ?? true;

  const toggle = (worktreeId: string) => {
    setPicked((prev) => {
      const next = new Set(prev ?? defaultSelection(forest.all));
      if (next.has(worktreeId)) next.delete(worktreeId);
      else next.add(worktreeId);
      return next;
    });
  };

  const clearFilters = () => {
    setFacet("all");
    setQuery("");
  };

  const setTidying = (next: boolean) => {
    setPicked(null);
    void navigate({
      to: "/forest",
      search: (prev) => ({ ...prev, tidy: next ? true : undefined }),
    });
  };

  const runRemovals = async () => {
    setConfirming(false);
    // Snapshot the selection so toggles during the run can't drift it.
    await runBatch(
      summary.selected,
      (entry) => entry.worktree.id,
      async (entry) => {
        await deleteWorktree.mutateAsync({
          projectId: entry.worktree.projectId,
          worktreeId: entry.worktree.id,
          // Force only where you explicitly acknowledged losing
          // uncommitted work. A clean worktree never needs it.
          force: entry.worktree.changedCount > 0,
        });
      },
    );
    setPicked(new Set());
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
  // provisional. Say so rather than showing a number that's about to
  // jump.
  const summaryLine = forest.isLoading
    ? "Counting the forest…"
    : narrowed
      ? `${forest.shown} of ${plural(forest.total, "worktree")}`
      : `${plural(forest.total, "worktree")} across ${plural(forest.plantedProjects, "project")}`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-0.5 border-b border-border px-6 pt-7 pb-4">
        <span className="truncate text-xs text-muted-foreground">
          {summaryLine}
        </span>
        {/* The display header the worktree page gets, not the small one
            the settings-shaped routes share. This is a destination you
            steer by, so it carries its own name at the same weight a
            branch does. Nothing else lives up here: every control this
            screen has is visible in the column below, where you can see
            what it's set to without opening anything. */}
        <h1 className="flex min-w-0 items-center gap-2 text-2xl font-medium tracking-tight">
          <Trees aria-hidden className="size-6 text-muted-foreground/70" />
          The forest
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-6">
          <ForestStrip
            tidying={tidying === true}
            disk={forest.disk}
            totals={forest.totals}
            total={forest.total}
            selectedCount={selected.size}
            reclaimBytes={summary.reclaimBytes}
          />

          <ForestToolbar
            facet={facet}
            onFacetChange={setFacet}
            sort={sort}
            onSortChange={(next) => setSort.mutate(next)}
            query={query}
            onQueryChange={setQuery}
            counts={forest.counts}
            tidying={tidying === true}
            onTidyingChange={setTidying}
            selectionLabel={
              tidying
                ? `${selected.size} of ${forest.selectableCount} selected`
                : undefined
            }
            disabled={batchRunning}
          />

          {forest.failedCount > 0 && (
            <ErrorBanner>
              Couldn&apos;t read worktrees for{" "}
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
              <ForestProjectGroup
                key={group.project.id}
                group={group}
                tidy={
                  tidying
                    ? {
                        selected,
                        status,
                        disabled: batchRunning,
                        onToggle: toggle,
                      }
                    : undefined
                }
              />
            ))
          )}

          {/* The last block in the column rather than a bar pinned to the
              viewport. Reading the list is the work, and the button that
              ends it belongs after the thing it acts on, mirroring the
              controls block above. */}
          {tidying && forest.groups.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Only merged worktrees with a clean tree are ticked for you.
                Anything else you pick yourself.
              </p>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0"
                disabled={selected.size === 0 || batchRunning}
                onClick={() => setConfirming(true)}
              >
                {batchRunning
                  ? "Removing…"
                  : `Remove ${plural(selected.size, "worktree")}`}
              </Button>
            </div>
          )}
        </div>
      </div>

      {confirming && (
        <TidyConfirm
          // Keyed on the risky set so an acknowledgement can't outlive
          // what it acknowledged. A background refetch that turns a
          // merged worktree dirty while the dialog is open remounts it
          // and re-arms the gate.
          key={summary.risky.map((entry) => entry.worktree.id).join()}
          summary={summary}
          deleteBranches={deleteBranches}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void runRemovals()}
        />
      )}
    </div>
  );
}

interface ForestStripProps {
  tidying: boolean;
  disk: ForestData["disk"];
  totals: ForestData["totals"];
  total: number;
  selectedCount: number;
  reclaimBytes: number;
}

// The three numbers that say whether the forest needs you, and in what
// order to look. Cross-project, because "which project is hoarding disk"
// is a question you can't ask one project at a time. Deliberately on the
// unfiltered totals: this is a survey of everything you own, so it must
// not move when you type in the filter box.
//
// The first tile changes with the mode, because the sizes don't exist
// until you ask to tidy. Surveying, the equivalent question is how much
// of the forest is asking for attention.
function ForestStrip({
  tidying,
  disk,
  totals,
  total,
  selectedCount,
  reclaimBytes,
}: ForestStripProps) {
  const measuredLabel = disk.measuring
    ? `measuring ${disk.measuredCount} of ${disk.totalCount}…`
    : disk.partial
      ? "approximate"
      : `across ${plural(disk.totalCount, "worktree")}`;

  return (
    <div className="grid grid-cols-3 gap-3">
      {tidying ? (
        <TidyStat
          label="On disk"
          value={`${disk.partial ? "~" : ""}${formatBytes(disk.measuredBytes)}`}
          detail={measuredLabel}
        />
      ) : (
        <TidyStat
          label="Wants attention"
          value={String(totals.attention)}
          detail={
            totals.attention > 0
              ? "unpushed, behind, or diverged"
              : "everything is in sync"
          }
        />
      )}
      <TidyStat
        label="Worktrees"
        value={String(total)}
        detail={`${totals.dirty} with uncommitted work`}
      />
      <TidyStat
        label="Safe to remove"
        value={String(totals.safe)}
        detail={
          !tidying
            ? "already merged into primary"
            : selectedCount > 0
              ? `selection frees about ${formatBytes(reclaimBytes)}`
              : "nothing ticked"
        }
        tone={totals.safe > 0 ? "positive" : "neutral"}
      />
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
  return (
    // A quiet dashed frame rather than skeleton rows: the list has a
    // known shape and this is the absence of it, so saying so in one
    // line beats faking four rows that will never arrive.
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {loading ? (
        <p>Counting the forest…</p>
      ) : narrowed ? (
        <>
          <p>No worktrees match this filter.</p>
          <Button size="xs" variant="outline" onClick={onClear}>
            Clear
          </Button>
        </>
      ) : (
        <>
          <p>No worktrees in any project yet.</p>
          <Button size="xs" variant="outline" onClick={onAddProject}>
            Add a project
          </Button>
        </>
      )}
    </div>
  );
}
