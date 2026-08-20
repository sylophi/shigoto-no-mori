import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import type { RowStatus } from "@/components/ui/row-status";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import {
  useAllProjectHygiene,
  useWorktreeDiskUsage,
} from "@/hooks/hygiene/useWorktreeHygiene";
import { useProjects } from "@/hooks/projects/useProjects";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { formatBytes } from "@/lib/formatBytes";
import { queryKeys } from "@/lib/queryKeys";
import {
  buildTidyEntries,
  groupByProject,
  isSelectable,
  safeToRemove,
  sortTidyEntries,
  sumBytes,
  summarize,
  TIDY_SORT_OPTIONS,
  type TidyEntry,
  type TidySort,
} from "./tidyModel";
import { TidyConfirm } from "./TidyConfirm";
import { TidyGroupHeading } from "./TidyGroupHeading";
import { TidyRow } from "./TidyRow";
import { TidyStat } from "./TidyStat";
import { withToggled } from "@/lib/toggleSet";

// One shared object for every un-started row: a fresh literal per render
// would give all 40 rows a new `status` prop each time a disk walk
// lands, defeating the memoization that keeps the list cheap.
const IDLE: RowStatus = { kind: "idle" };

// The whole forest at once: every worktree of every registered project,
// what it costs on disk, how stale it is, and whether its work already
// landed. Scoped to the app rather than to one project because that is
// the question being asked -- disk fills up per machine, and the
// worktree worth removing first is rarely in the repo you happen to have
// open.
export function TidyForest() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: allProjects = [], isLoading: projectsLoading } = useProjects();
  // A project whose folder has moved or been deleted answers every git
  // call with ENOENT. The sidebar already flags those, so here they are
  // simply left out and one broken entry can't fill the page with rows
  // that can't be judged.
  const projects = allProjects.filter(
    (project) => project.pathExists !== false,
  );
  const worktreeQueries = useAllProjectWorktrees(projects);
  const hygiene = useAllProjectHygiene(projects);
  const { data: globalConfig } = useGlobalConfig();

  const worktreesByProject = new Map<string, Worktree[]>(
    projects.map((project, index) => [
      project.id,
      worktreeQueries[index]?.data ?? [],
    ]),
  );
  const allWorktrees = worktreeQueries.flatMap((query) => query.data ?? []);
  const disk = useWorktreeDiskUsage(allWorktrees);

  const [sort, setSort] = useState<TidySort>("recommended");
  // null means "the user hasn't touched the selection", so the safe-only
  // default keeps tracking the data as hygiene facts arrive. The first
  // toggle materializes it and from then on the user is in charge.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { status, batchRunning, runBatch } = useSequentialBatch();
  const deleteWorktree = useDeleteWorktree();

  const entries = buildTidyEntries(
    projects,
    worktreesByProject,
    hygiene.byId,
    disk.byId,
    disk.failed,
  );
  const ordered = sortTidyEntries(entries, sort);
  const candidates = safeToRemove(entries);
  const safeIds = new Set(candidates.map((entry) => entry.worktree.id));
  const selected = picked ?? safeIds;
  const summary = summarize(entries, selected);
  const selectableCount = entries.filter(isSelectable).length;
  const deleteBranches = globalConfig?.deleteBranchOnRemove ?? true;
  const loading =
    projectsLoading ||
    (entries.length === 0 && worktreeQueries.some((query) => query.isPending));

  const statusOf = (worktreeId: string) => status.get(worktreeId) ?? IDLE;

  const toggle = (worktreeId: string) => {
    // Null picked means "everything safe is selected", so seed from
    // that before flipping the one the user clicked.
    setPicked((prev) => withToggled(worktreeId)(prev ?? safeIds));
  };

  const runRemovals = async () => {
    setConfirming(false);
    // Snapshot the selection so toggles during the run can't drift it.
    const queue = summary.selected;
    await runBatch(
      queue,
      (entry) => entry.worktree.id,
      async (entry) => {
        const result = await deleteWorktree.mutateAsync({
          projectId: entry.project.id,
          worktreeId: entry.worktree.id,
          // Force only where the user explicitly acknowledged losing
          // work, and let the verdict decide what counts: untracked
          // files under `-uno` make git refuse without --force while
          // changedCount reads zero.
          force: entry.verdict.needsForce,
        });
        // Deletion resolves either way: `ok: false` means a teardown
        // script or a port release failed and the worktree is still on
        // disk. Raising it here is what marks the row failed instead of
        // "Removed", and keeps its bytes out of the freed total.
        if (!result.ok) {
          throw new Error(
            result.cleanupError.phase === "teardown"
              ? "Teardown script failed. The worktree is still on disk."
              : "Releasing its ports failed. The worktree is still on disk.",
          );
        }
      },
    );
    // Removing a worktree doesn't change any *other* worktree's facts,
    // but the primary-ref comparison is per project and the row is gone
    // either way -- refetching the projects we touched keeps the counts
    // and the "safe to remove" tally honest without re-probing repos the
    // run never went near.
    for (const projectId of new Set(queue.map((entry) => entry.project.id))) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktreeHygiene(projectId),
      });
    }
    setPicked(new Set());
  };

  const measuredLabel = disk.measuring
    ? `measuring ${disk.measuredCount} of ${disk.totalCount}…`
    : disk.partial
      ? "approximate"
      : `across ${projects.length} ${projects.length === 1 ? "project" : "projects"}`;

  const dirtyCount = entries.filter(
    (entry) => entry.worktree.changedCount > 0,
  ).length;
  const reclaimable = sumBytes(candidates);

  return (
    <div className="flex h-full flex-col">
      <header className="relative flex items-center gap-3 overflow-hidden border-b border-border px-6 pt-7 pb-4">
        <div className="relative z-[1] flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            Shigoto no Mori
          </span>
          <h1 className="text-lg font-medium tracking-tight">
            Tidy the forest
          </h1>
        </div>
        <span
          aria-hidden
          className="doubutsu-only pointer-events-none absolute -top-6 right-2 text-[120px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-10 select-none"
        >
          掃除
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-6">
          <div className="grid grid-cols-3 gap-3">
            <TidyStat
              label="On disk"
              value={`${disk.partial ? "~" : ""}${formatBytes(disk.measuredBytes)}`}
              detail={measuredLabel}
            />
            <TidyStat
              label="Worktrees"
              value={String(allWorktrees.length)}
              detail={
                dirtyCount > 0
                  ? `${dirtyCount} with uncommitted work`
                  : loading
                    ? "checking…"
                    : "all clean"
              }
            />
            <TidyStat
              label="Safe to remove"
              value={String(candidates.length)}
              detail={
                candidates.length > 0
                  ? `frees about ${formatBytes(reclaimable)}`
                  : hygiene.loading
                    ? "still checking…"
                    : "nothing to tidy"
              }
              tone={candidates.length > 0 ? "positive" : "neutral"}
            />
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {projects.length === 0
                ? "No projects to tidy yet."
                : "No worktrees in any project yet."}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <SegmentedControl
                  aria-label="Sort worktrees"
                  value={sort}
                  onChange={setSort}
                  options={TIDY_SORT_OPTIONS}
                  disabled={batchRunning}
                />
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {selected.size} of {selectableCount} selected
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    // Clearing is available whenever something is
                    // ticked, even where nothing was safe enough to
                    // offer in the first place.
                    disabled={
                      batchRunning ||
                      (selected.size === 0 && candidates.length === 0)
                    }
                    onClick={() =>
                      setPicked(selected.size > 0 ? new Set() : safeIds)
                    }
                  >
                    {selected.size > 0 ? "Clear" : "Select safe"}
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {sort === "project" ? (
                  groupByProject(ordered).map((group) => (
                    <div key={group.project.id} className="flex flex-col gap-2">
                      <TidyGroupHeading
                        project={group.project}
                        count={group.entries.length}
                        bytes={group.bytes}
                      />
                      <TidyList
                        entries={group.entries}
                        selected={selected}
                        statusOf={statusOf}
                        disabled={batchRunning}
                        onToggle={toggle}
                        showProject={false}
                      />
                    </div>
                  ))
                ) : (
                  <TidyList
                    entries={ordered}
                    selected={selected}
                    statusOf={statusOf}
                    disabled={batchRunning}
                    onToggle={toggle}
                    showProject
                  />
                )}
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Only merged worktrees with a clean tree are ticked for you.
                  Anything else you pick yourself.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate({ to: "/" })}
                    disabled={batchRunning}
                  >
                    {batchRunning ? "Working…" : "Cancel"}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={selected.size === 0 || batchRunning}
                    onClick={() => setConfirming(true)}
                  >
                    {batchRunning
                      ? "Removing…"
                      : `Remove ${selected.size} ${selected.size === 1 ? "worktree" : "worktrees"}`}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {confirming && (
        <TidyConfirm
          summary={summary}
          deleteBranches={deleteBranches}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void runRemovals()}
        />
      )}
    </div>
  );
}

interface TidyListProps {
  entries: TidyEntry[];
  selected: ReadonlySet<string>;
  statusOf: (worktreeId: string) => RowStatus;
  disabled: boolean;
  onToggle: (worktreeId: string) => void;
  // Off inside a project group, where the heading already says it.
  showProject: boolean;
}

// Bordered card of rows, rendered once flat or once per project group.
function TidyList({
  entries,
  selected,
  statusOf,
  disabled,
  onToggle,
  showProject,
}: TidyListProps) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {entries.map((entry) => (
        <TidyRow
          key={entry.worktree.id}
          entry={entry}
          checked={selected.has(entry.worktree.id)}
          status={statusOf(entry.worktree.id)}
          disabled={disabled}
          onToggle={() => onToggle(entry.worktree.id)}
          showProject={showProject}
        />
      ))}
    </div>
  );
}
