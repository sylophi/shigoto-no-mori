import { useState } from "react";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useShigomoriWrite } from "@/hooks/config/useShigomoriWrite";
import type { DeviceLayout } from "@shigomori/ui/views/worktreeLocation/layoutOptions.ts";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useRelocateWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useRelocationPlan } from "@/hooks/worktrees/useRelocationPlan";
import {
  isManagedWorktree,
  PROJECT_CONFIG_DEFAULTS,
  type RelocationPlan,
  type ShigomoriConfig,
  type Worktree,
  type WorktreeLayout,
} from "@shigomori/contracts/schemas";
import { pluralize } from "@shigomori/ui/lib/pluralize.ts";
import { LocationFormView } from "@shigomori/ui/views/worktreeLocation/LocationFormView.tsx";

interface LocationFormProps {
  projectId: string;
  projectPath: string;
  device: DeviceLayout;
  worktrees: readonly Worktree[];
  config: ShigomoriConfig | null;
  resolvedDefaultBranch: string;
}

export function LocationForm({
  projectId,
  projectPath,
  device,
  worktrees,
  config,
  resolvedDefaultBranch,
}: LocationFormProps) {
  const { toProjectPage } = useProjectNav();
  const write = useShigomoriWrite();
  const relocate = useRelocateWorktree();

  const savedLayout =
    config?.worktreeLayout ?? PROJECT_CONFIG_DEFAULTS.worktreeLayout;
  const savedCustomPath = config?.customWorktreePath ?? "";
  // A draft follows the stored config until it is edited here, so a
  // change another window or the terminal made shows rather than being
  // offered back as this form's.
  const [layoutDraft, setLayout] = useState<WorktreeLayout | null>(null);
  const [customPathDraft, setCustomPath] = useState<string | null>(null);
  const layout = layoutDraft ?? savedLayout;
  const customPath = customPathDraft ?? savedCustomPath;
  const { status, batchRunning, runBatch } = useSequentialBatch();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Custom layout with no folder picked yet has no resolvable
  // destination, and nothing to plan.
  const customMissing = layout === "custom" && !customPath.trim();

  // Non-primary worktrees only. The primary checkout sits at projectPath
  // and can't be moved. Externals can't be moved either: `git worktree
  // move` works only on managed worktrees we created.
  const movable = worktrees.filter(isManagedWorktree);

  const plan = useRelocationPlan(
    projectId,
    layout,
    customPath.trim() || null,
    device.onProjectDrive,
    !customMissing,
  );
  const movesOf = (entries: RelocationPlan) => {
    const planned = new Map(entries.map((entry) => [entry.worktreeId, entry]));
    return movable.flatMap((worktree) => {
      const entry = planned.get(worktree.id);
      return entry === undefined || entry.inPlace
        ? []
        : [{ worktree, destination: entry.destination }];
    });
  };
  const toMove = customMissing ? [] : movesOf(plan.data ?? []);

  const layoutChanged =
    layout !== savedLayout || customPath.trim() !== savedCustomPath.trim();

  // Only on a plan read: without one, an apply would save the layout
  // and move nothing.
  const canSubmit =
    (layoutChanged || toMove.length > 0) &&
    !batchRunning &&
    !customMissing &&
    plan.isSuccess &&
    !plan.isFetching;

  const handleApply = async () => {
    // The plan asked again under the batch's flag, so the form holds
    // still from the click; and moved by the plan alone, so a worktree
    // made since the list was last pushed moves too.
    const moves = async () => {
      const fresh = await plan.refetch();
      return fresh.isSuccess
        ? fresh.data.filter((entry) => !entry.inPlace)
        : null;
    };

    // The config write runs as the batch's prepare step so the form
    // stays disabled across it and a write failure aborts the moves.
    const saveLayoutIfChanged = async (): Promise<boolean> => {
      if (!layoutChanged) return true;
      // If the project has no on-disk config yet, fall back to the resolved
      // default branch so we never invent a branch name like "main" on a repo
      // that uses "master". Hoisted out of the try below: React Compiler
      // can't lower a ?? inside one.
      const baseConfig: ShigomoriConfig = config ?? {
        defaultBranch: resolvedDefaultBranch,
      };
      const nextCustomPath = layout === "custom" ? customPath.trim() : "";
      const nextConfig: ShigomoriConfig = {
        ...baseConfig,
        worktreeLayout: layout,
        customWorktreePath: nextCustomPath || undefined,
      };
      try {
        // Answers once the config is read again, so the drafts let go
        // onto what was stored.
        await write.mutateAsync({ projectId, config: nextConfig });
        setLayout(null);
        setCustomPath(null);
        return true;
      } catch {
        // useShigomoriWrite already surfaces an error toast via its meta.
        return false;
      }
    };

    await runBatch(
      moves,
      (entry) => entry.worktreeId,
      async ({ worktreeId, destination }) => {
        await relocate.mutateAsync({
          projectId,
          worktreeId,
          destinationPath: destination,
        });
      },
      { prepare: saveLayoutIfChanged },
    );
  };

  const submitLabel = batchRunning
    ? toMove.length > 0
      ? "Moving…"
      : "Saving…"
    : toMove.length > 0
      ? `Move ${pluralize(toMove.length, "worktree")}`
      : "Save location";

  return (
    <LocationFormView
      layout={layout}
      onLayout={setLayout}
      projectPath={projectPath}
      device={device}
      customPath={customPath}
      onOpenPicker={() => setPickerOpen(true)}
      toMove={toMove}
      status={status}
      saveError={write.error?.message ?? null}
      canSubmit={canSubmit}
      batchRunning={batchRunning}
      submitLabel={submitLabel}
      onBack={() => toProjectPage("configure", projectId)}
      onApply={() => void handleApply()}
      picker={
        pickerOpen && (
          <FolderPickerModal
            initialPath={customPath.trim() || undefined}
            title="Filter folders…"
            confirmLabel="Use this folder"
            onPick={(path) => {
              setCustomPath(path);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )
      }
    />
  );
}
