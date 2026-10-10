import { sanitizeBranchForPath } from "@shigomori/contracts/predicates/worktreeDirName";
import { useState } from "react";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { tildify } from "@shigomori/contracts/projectPaths";
import { useGoBack } from "@/hooks/ui/useGoBack";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useDeviceLayout } from "@/hooks/config/useDeviceLayout";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useConvertExternalWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { layoutInputsFor, worktreePathFor } from "@shared/git/worktreeLayout";
import { ConvertExternalView } from "./ConvertExternalView";
import { withToggled } from "@/lib/toggleSet";
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

  return (
    <ConvertExternalView
      externals={externals}
      isLoading={isLoading}
      selected={selected}
      status={status}
      batchRunning={batchRunning}
      proposedPaths={new Map(externals.map((wt) => [wt.id, proposedPath(wt)]))}
      home={home}
      onToggle={toggle}
      onToggleAll={toggleAll}
      onBack={goBack}
      onConvert={() => void runConversions()}
    />
  );
}
