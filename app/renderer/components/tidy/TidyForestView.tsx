// The Tidy page, drawn (TidyForest.tsx binds it): the figures of one
// device's forest, the sort and the selection, the rows, and the
// removal.
import type { ReactNode } from "react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SegmentedControl } from "@shigomori/ui/primitives/segmented-control.tsx";
import { PageHeaderView } from "@/components/shared/PageHeaderView";
import { PAGE_BODY } from "@/components/shared/PageShellView";
import type { DiskUsageTotals } from "@/hooks/hygiene/useWorktreeHygiene";
import { formatBytes } from "@/lib/formatBytes";
import { TIDY_SORT_OPTIONS, type TidySort } from "./tidyModel";
import { TidyStatView } from "./TidyStatView";

export function TidyPageView({
  tabs,
  children,
}: {
  // One tab per machine on the account, when there is more than one.
  tabs: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-doubutsu-page="tidy" className="flex h-full flex-col">
      <PageHeaderView
        eyebrow="Settings"
        title="Tidy the forest"
        watermark="掃除"
        tabs={tabs}
      />
      {children}
    </div>
  );
}

export function TidyBodyView({
  disk,
  projectCount: rowProjects,
  worktreeCount,
  dirtyCount,
  safeCount,
  reclaimable,
  loading,
  hygieneLoading,
  noProjects,
  sort,
  onSort,
  selectedCount,
  batchRunning,
  onToggleSelection,
  onBack,
  onRemove,
  lists,
  confirm,
}: {
  // The disk walks so far.
  disk: Pick<
    DiskUsageTotals,
    "measuredBytes" | "measuredCount" | "totalCount" | "measuring" | "partial"
  >;
  // Projects with a row: a repo never branched from contributes none.
  projectCount: number;
  worktreeCount: number;
  dirtyCount: number;
  // Merged worktrees with a clean tree, and what they free.
  safeCount: number;
  reclaimable: number;
  loading: boolean;
  hygieneLoading: boolean;
  noProjects: boolean;
  sort: TidySort;
  onSort: (sort: TidySort) => void;
  selectedCount: number;
  batchRunning: boolean;
  // Clearing is available whenever something is ticked, even where
  // nothing was safe enough to offer in the first place: with nothing
  // ticked, it ticks the safe ones.
  onToggleSelection: () => void;
  onBack: () => void;
  onRemove: () => void;
  // The rows: one card, or one per project group.
  lists: ReactNode;
  // The confirm, while it is up.
  confirm: ReactNode;
}) {
  const measuredLabel = disk.measuring
    ? `measuring ${disk.measuredCount} of ${disk.totalCount}…`
    : disk.partial
      ? "approximate"
      : `across ${rowProjects} ${rowProjects === 1 ? "project" : "projects"}`;

  return (
    <>
      <div className={PAGE_BODY}>
        <div className="flex flex-col gap-6">
          {/* A narrower gutter on a phone: three columns leave a card just
              short of its longest word at the full one. */}
          <div className="grid grid-cols-3 gap-3 phone:gap-2">
            <TidyStatView
              label="Reclaimable"
              value={`${disk.partial ? "~" : ""}${formatBytes(disk.measuredBytes)}`}
              detail={measuredLabel}
            />
            <TidyStatView
              label="Worktrees"
              value={String(worktreeCount)}
              detail={
                dirtyCount > 0
                  ? `${dirtyCount} with uncommitted work`
                  : loading
                    ? "checking…"
                    : "all clean"
              }
            />
            <TidyStatView
              label="Safe to remove"
              value={String(safeCount)}
              detail={
                safeCount > 0
                  ? `frees about ${formatBytes(reclaimable)}`
                  : hygieneLoading
                    ? "still checking…"
                    : "nothing to tidy"
              }
              tone={safeCount > 0 ? "positive" : "neutral"}
            />
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : worktreeCount === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {noProjects
                ? "No projects to tidy yet."
                : "No worktrees in any project yet."}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 phone:flex-wrap">
                <SegmentedControl
                  aria-label="Sort worktrees"
                  value={sort}
                  onChange={onSort}
                  options={TIDY_SORT_OPTIONS}
                  disabled={batchRunning}
                />
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {selectedCount} of {worktreeCount} selected
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={
                      batchRunning || (selectedCount === 0 && safeCount === 0)
                    }
                    onClick={onToggleSelection}
                  >
                    {selectedCount > 0 ? "Clear" : "Select safe"}
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-4">{lists}</div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Only merged worktrees with a clean tree are ticked for you.
                  Anything else you pick yourself.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onBack}
                    disabled={batchRunning}
                  >
                    {batchRunning ? "Working…" : "Cancel"}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={selectedCount === 0 || batchRunning}
                    onClick={onRemove}
                  >
                    {batchRunning
                      ? "Removing…"
                      : `Remove ${selectedCount} ${selectedCount === 1 ? "worktree" : "worktrees"}`}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {confirm}
    </>
  );
}

// One project's block of rows, under its heading.
export function TidyGroupView({
  heading,
  children,
}: {
  heading: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {heading}
      {children}
    </div>
  );
}

// Bordered card of rows, rendered once flat or once per project group.
export function TidyListView({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {children}
    </div>
  );
}
