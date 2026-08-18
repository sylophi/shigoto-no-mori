import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import {
  useWorktreeDiskUsage,
  useWorktreeHygiene,
} from "@/hooks/hygiene/useWorktreeHygiene";
import { useProjects } from "@/hooks/projects/useProjects";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { formatBytes } from "@/lib/formatBytes";
import {
  buildTidyEntries,
  defaultSelection,
  isSelectable,
  sortTidyEntries,
  summarize,
  TIDY_SORT_OPTIONS,
  type TidySort,
} from "./tidyModel";
import { TidyConfirm } from "./TidyConfirm";
import { TidyRow } from "./TidyRow";
import { TidyStat } from "./TidyStat";

const route = getRouteApi("/projects/$projectId/tidy");

export function TidyForest() {
  const { projectId } = route.useParams();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: worktrees = [], isLoading } = useWorktrees(projectId);
  const { data: hygiene = [] } = useWorktreeHygiene(projectId);
  const { data: globalConfig } = useGlobalConfig();
  const disk = useWorktreeDiskUsage(
    projectId,
    worktrees.map((worktree) => worktree.id),
  );

  const [sort, setSort] = useState<TidySort>("recommended");
  // null means "the user hasn't touched the selection", so the safe-only
  // default keeps tracking the data as hygiene facts arrive. The first
  // toggle materializes it and from then on the user is in charge.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { status, batchRunning, runBatch } = useSequentialBatch();
  const deleteWorktree = useDeleteWorktree();

  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const entries = buildTidyEntries(
    worktrees,
    new Map(hygiene.map((facts) => [facts.worktreeId, facts])),
    disk.byId,
  );
  const ordered = sortTidyEntries(entries, sort);
  const selected = picked ?? defaultSelection(entries);
  const summary = summarize(entries, selected);
  const candidates = entries.filter((entry) => entry.verdict.safe);
  const deleteBranches = globalConfig?.deleteBranchOnRemove ?? true;

  const toggle = (worktreeId: string) => {
    setPicked((prev) => {
      const next = new Set(prev ?? defaultSelection(entries));
      if (next.has(worktreeId)) next.delete(worktreeId);
      else next.add(worktreeId);
      return next;
    });
  };

  const runRemovals = async () => {
    setConfirming(false);
    // Snapshot the selection so toggles during the run can't drift it.
    const queue = summary.selected;
    await runBatch(
      queue,
      (entry) => entry.worktree.id,
      async (entry) => {
        await deleteWorktree.mutateAsync({
          projectId: project.id,
          worktreeId: entry.worktree.id,
          // Force only where the user explicitly acknowledged losing
          // uncommitted work; a clean worktree never needs it.
          force: entry.worktree.changedCount > 0,
        });
      },
    );
    setPicked(new Set());
  };

  const measuredLabel = disk.measuring
    ? `measuring ${disk.measuredCount} of ${disk.totalCount}…`
    : disk.partial
      ? "approximate"
      : `across ${disk.totalCount} ${disk.totalCount === 1 ? "worktree" : "worktrees"}`;

  const reclaimable = candidates.reduce(
    (sum, entry) => sum + (entry.disk?.bytes ?? 0),
    0,
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">
            Tidy the forest
          </h1>
        </div>
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
              value={String(worktrees.length)}
              detail={`${entries.filter((entry) => entry.worktree.changedCount > 0).length} with uncommitted work`}
            />
            <TidyStat
              label="Safe to remove"
              value={String(candidates.length)}
              detail={
                candidates.length > 0
                  ? `frees about ${formatBytes(reclaimable)}`
                  : "nothing to tidy"
              }
              tone={candidates.length > 0 ? "positive" : "neutral"}
            />
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No worktrees in this project yet.
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
                <span className="text-xs text-muted-foreground">
                  {selected.size} of {entries.filter(isSelectable).length}{" "}
                  selected
                </span>
              </div>

              <div className="overflow-hidden rounded-md border border-border">
                {ordered.map((entry, index) => (
                  <TidyRow
                    key={entry.worktree.id}
                    entry={entry}
                    checked={selected.has(entry.worktree.id)}
                    status={status.get(entry.worktree.id) ?? { kind: "idle" }}
                    disabled={batchRunning}
                    onToggle={() => toggle(entry.worktree.id)}
                    isLast={index === ordered.length - 1}
                  />
                ))}
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
