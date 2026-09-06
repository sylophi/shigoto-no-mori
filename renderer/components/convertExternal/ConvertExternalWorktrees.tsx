import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { ErrorBanner } from "@/components/ui/error-banner";
import { tildify } from "@/lib/projectPaths";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useScopedProjectParams } from "@/hooks/projects/useProjectNav";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useConvertExternalWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { sanitizeBranchForPath } from "@shared/branches";
import type { Worktree } from "@shared/schemas";
import { worktreePathFor } from "@shared/worktreeLayout";
import { ConvertRow } from "./ConvertRow";
import { withToggled } from "@/lib/toggleSet";

// For detached HEADs `worktree.branch` is a short SHA -- pass it
// through unchanged so the managed worktree gets a hash-named dir.
// (isRealBranch only filters the UNKNOWN_BRANCH sentinel, which we
// never see here.)
const proposedName = (worktree: Worktree): string =>
  worktree.detached ? worktree.branch : sanitizeBranchForPath(worktree.branch);

export function ConvertExternalWorktrees() {
  const { projectId } = useScopedProjectParams();
  const navigate = useNavigate();
  // Scope-aware: a worktree converted on a peer opens under its device
  // twin, like every other link out of a scoped page.
  const { toWorktree } = useWorktreeNav();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const { data: worktrees = [], isLoading } = useWorktrees(projectId);
  const { data: config } = useShigomoriConfig(projectId);
  const convert = useConvertExternalWorktree();

  const project = projects.find((p) => p.id === projectId);
  const externals = worktrees.filter((w) => w.isExternal && !w.isPrimary);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { status, batchRunning, runBatch } = useSequentialBatch();

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const home = runtime?.homedir ?? null;

  const proposedPath = (worktree: Worktree): string => {
    if (!runtime) return "";
    // A branch whose name sanitizes to nothing (reserved words like
    // root/primary, DOS device names) gets a generated folder name at
    // convert time; show that honestly instead of a path with an empty
    // leaf.
    return tildify(
      worktreePathFor(
        {
          layout: config?.worktreeLayout ?? "managed-root",
          projectPath: project.path,
          dataDir: runtime.dataDir,
          customPath: config?.customWorktreePath ?? null,
        },
        proposedName(worktree) || "(generated name)",
      ),
      home,
    );
  };

  const toggle = (id: string) => {
    setSelected(withToggled(id));
  };

  const toggleAll = () => {
    if (selected.size === externals.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(externals.map((w) => w.id)));
    }
  };

  const runConversions = async () => {
    if (batchRunning || selected.size === 0) return;
    // Snapshot the selection so toggles during the run don't drift it.
    const queue = externals.filter((w) => selected.has(w.id));
    const converted: Worktree[] = [];
    await runBatch(
      queue,
      (wt) => wt.id,
      async (wt) => {
        const result = await convert.mutateAsync({
          projectId: project.id,
          worktreeId: wt.id,
        });
        converted.push(result.worktree);
      },
    );
    setSelected(new Set());

    // One success? Drop the user into it. Multiple successes? Stay on the
    // page so they can see what happened with the rest.
    const lastSuccess = converted.at(-1) ?? null;
    if (lastSuccess && queue.length === 1) {
      toWorktree(project.id, lastSuccess.id);
    }
  };

  const selectableCount = externals.length;
  const allSelected = selectableCount > 0 && selected.size === selectableCount;
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">
            Convert external worktrees
          </h1>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-6">
          <ErrorBanner>
            <p className="text-[11px] font-semibold tracking-wide uppercase">
              This is destructive
            </p>
            <p className="mt-2 leading-relaxed">
              Each selected worktree is removed from its current location and
              re-checked-out under this project&apos;s managed worktree
              location. Uncommitted changes, untracked files, and any state
              inside the old worktree directory are wiped. The branch is then
              checked out fresh under Shigoto no Mori&apos;s pipelines:
              carry-over, setup script, and port-pool provision all run as if
              you had just created it.
            </p>
          </ErrorBanner>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : externals.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No external worktrees to convert. Anything you create from Shigoto
              no Mori already lives in the managed tree.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={toggleAll}
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
                  <ConvertRow
                    key={wt.id}
                    worktree={wt}
                    checked={selected.has(wt.id)}
                    status={status.get(wt.id) ?? { kind: "idle" }}
                    disabled={batchRunning}
                    indeterminateHeader={someSelected}
                    proposedPath={proposedPath(wt)}
                    home={home}
                    onToggle={() => toggle(wt.id)}
                  />
                ))}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate({ to: "/" })}
                  disabled={batchRunning}
                >
                  {batchRunning ? "Working…" : "Cancel"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void runConversions()}
                  disabled={selected.size === 0 || batchRunning}
                >
                  {batchRunning ? "Converting…" : "Convert"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
