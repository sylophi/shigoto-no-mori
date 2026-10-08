import { sanitizeBranchForPath } from "@shigomori/contracts/predicates/worktreeDirName";
import { useState } from "react";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { tildify } from "@shared/projectPaths";
import { useGoBack } from "@/hooks/ui/useGoBack";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useDeviceLayout } from "@/hooks/config/useDeviceLayout";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useConvertExternalWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { layoutInputsFor, worktreePathFor } from "@shared/git/worktreeLayout";
import { ConvertRow } from "./ConvertRow";
import { withToggled } from "@/lib/toggleSet";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { isConvertRefusedError } from "@shigomori/contracts/errors";

// For detached HEADs `worktree.branch` is a short SHA. Pass it
// through unchanged so the managed worktree gets a hash-named dir.
// (isRealBranch only filters the UNKNOWN_BRANCH sentinel, which we
// never see here.)
const proposedName = (worktree: Worktree): string =>
  worktree.detached ? worktree.branch : sanitizeBranchForPath(worktree.branch);

export function ConvertExternalWorktrees() {
  return (
    <ProjectDevicePage title="Convert external worktrees">
      {(scoped) => <ConvertExternalBody project={scoped} />}
    </ProjectDevicePage>
  );
}

// The externals of whichever device the surrounding scope names.
function ConvertExternalBody({ project }: { project: Project }) {
  // Scope-aware: a worktree converted on a peer opens under that
  // device's route, like every other link out of a scoped page.
  const { toWorktree } = useWorktreeNav();
  const device = useDeviceLayout();
  const { data: worktrees = [], isLoading } = useWorktrees(project.id);
  const { data: config } = useShigomoriConfig(project.id);
  const convert = useConvertExternalWorktree();

  const externals = worktrees.filter((w) => w.isExternal && !w.isPrimary);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { status, batchRunning, runBatch } = useSequentialBatch();
  // Once a batch has run, the page behind may be one it removed.
  const goBack = useGoBack({ home: status.size > 0 });

  const home = device?.homedir ?? null;

  const proposedPath = (worktree: Worktree): string => {
    if (!device) return "";
    // A branch whose name sanitizes to nothing (reserved words like
    // root/primary, DOS device names) gets a generated folder name at
    // convert time; show that honestly instead of a path with an empty
    // leaf.
    return tildify(
      worktreePathFor(
        layoutInputsFor(config ?? null, project.path, device),
        proposedName(worktree) || "(generated name)",
      ),
      home,
    );
  };

  const toggle = (id: string) => {
    setSelected(withToggled(id));
  };

  const toggleAll = () =>
    setSelected(
      selected.size === externals.length
        ? new Set()
        : new Set(externals.map((w) => w.id)),
    );

  const runConversions = async () => {
    if (batchRunning || selected.size === 0) return;
    // Snapshot the selection so toggles during the run don't drift it.
    const queue = externals.filter((w) => selected.has(w.id));
    const converted: Worktree[] = [];
    await runBatch(
      queue,
      (wt) => wt.id,
      async (wt) => {
        // Unforced first, whatever the row's count showed: the CLI's
        // guard also sees what the row can't (an untracked file under
        // `status.showUntrackedFiles no`, an edit since the list
        // loaded), and its refusal is the one warning before a wipe.
        // A row forces only while that refusal is the status it shows,
        // which the next batch replaces.
        const shown = status.get(wt.id);
        const force =
          shown?.kind === "error" && isConvertRefusedError(shown.error);
        const result = await convert.mutateAsync({
          projectId: project.id,
          worktreeId: wt.id,
          force,
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
                onClick={goBack}
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
  );
}
