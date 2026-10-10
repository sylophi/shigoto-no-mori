import { Button } from "../../primitives/button.tsx";
import { ErrorBanner } from "../../primitives/error-banner.tsx";
import type { RowStatus } from "../../primitives/row-status.tsx";
import { PAGE_BODY } from "../shared/PageShellView.tsx";
import type { Worktree } from "@shigomori/contracts/schemas/index";
import { ConvertRowView } from "./ConvertRowView.tsx";
import { EmptyPanel } from "../../primitives/empty-panel.tsx";

// A device's external worktrees, picked to move under the project's
// managed location (ConvertExternalWorktrees.tsx runs the moves).
export function ConvertExternalView({
  externals,
  isLoading,
  selected,
  status,
  batchRunning,
  proposedPaths,
  home,
  onToggle,
  onToggleAll,
  onBack,
  onConvert,
}: {
  externals: readonly Worktree[];
  isLoading: boolean;
  selected: ReadonlySet<string>;
  // Each row's state in the run, by worktree id.
  status: ReadonlyMap<string, RowStatus>;
  batchRunning: boolean;
  // Where each one lands, tildified, by worktree id.
  proposedPaths: ReadonlyMap<string, string>;
  home: string | null;
  onToggle: (worktreeId: string) => void;
  onToggleAll: () => void;
  onBack: () => void;
  onConvert: () => void;
}) {
  const selectableCount = externals.length;
  const allSelected = selectableCount > 0 && selected.size === selectableCount;

  return (
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-6">
        <ErrorBanner>
          <p className="text-2xs font-semibold tracking-wide uppercase">
            This is destructive
          </p>
          <p className="mt-2 leading-relaxed">
            Each selected worktree is removed from its current location and
            re-checked-out under this project&apos;s managed worktree location.
            Uncommitted changes, untracked files, and any state inside the old
            worktree directory are wiped. The branch is then checked out fresh
            under Shigoto no Mori&apos;s pipelines: carry-over, setup script,
            and port-pool provision all run as if you had just created it.
          </p>
        </ErrorBanner>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : externals.length === 0 ? (
          <EmptyPanel>
            No external worktrees to convert. Anything you create from Shigoto
            no Mori already lives in the managed tree.
          </EmptyPanel>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={onToggleAll}
                disabled={batchRunning}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
              <span className="text-xs text-muted-foreground">
                {selected.size} of {selectableCount} selected
              </span>
            </div>

            <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {externals.map((wt) => (
                <ConvertRowView
                  key={wt.id}
                  worktree={wt}
                  checked={selected.has(wt.id)}
                  status={status.get(wt.id) ?? { kind: "idle" }}
                  disabled={batchRunning}
                  proposedPath={proposedPaths.get(wt.id) ?? ""}
                  home={home}
                  onToggle={() => onToggle(wt.id)}
                />
              ))}
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onBack}
                disabled={batchRunning}
              >
                {batchRunning ? "Working…" : "Cancel"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onConvert}
                disabled={selected.size === 0 || batchRunning}
              >
                {batchRunning ? "Converting…" : "Convert"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
