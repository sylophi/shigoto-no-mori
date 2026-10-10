import { useEffect, useState } from "react";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useShigomoriWrite } from "@/hooks/config/useShigomoriWrite";
import type { DeviceLayout } from "@/hooks/config/useDeviceLayout";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useRelocateWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import {
  isManagedWorktree,
  PROJECT_CONFIG_DEFAULTS,
  type ShigomoriConfig,
  type Worktree,
  type WorktreeLayout,
} from "@shigomori/contracts/schemas";
import { worktreePathFor } from "@shared/git/worktreeLayout";
import { pluralize } from "@/lib/pluralize";
import { LocationFormView } from "./LocationFormView";

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
  // react-doctor-disable-next-line react-doctor/prefer-useReducer -- per-field setters are simple; saved* mirrors track persisted state without coupling between fields
}: LocationFormProps) {
  const { toProjectPage } = useProjectNav();
  const write = useShigomoriWrite();
  const relocate = useRelocateWorktree();

  // Mirror the persisted config in local state so we can flip it
  // immediately after a successful save. Reading the config prop
  // directly would lag while the shigomori query refetches, which
  // briefly re-enables the Move button after a batch completes.
  const configLayout =
    config?.worktreeLayout ?? PROJECT_CONFIG_DEFAULTS.worktreeLayout;
  const configCustomPath = config?.customWorktreePath ?? "";
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- savedLayout tracks the last-persisted value, not the prop; updated in handleApply and synced from the prop only when no batch is in flight
  const [savedLayout, setSavedLayout] = useState<WorktreeLayout>(configLayout);
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- savedCustomPath tracks the last-persisted value, not the prop; updated in handleApply and synced from the prop only when no batch is in flight
  const [savedCustomPath, setSavedCustomPath] =
    useState<string>(configCustomPath);

  const [layout, setLayout] = useState<WorktreeLayout>(savedLayout);
  const [customPath, setCustomPath] = useState<string>(savedCustomPath);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const { status, batchRunning, runBatch } = useSequentialBatch();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Pick up external config changes (e.g. another window edited the project).
  // Keying the parent on the config would remount us mid-batch and orphan
  // the in-flight relocate loop, so we sync the mirrors instead and skip
  // while a batch is running.
  // react-doctor-disable-next-line react-doctor/no-derived-state-effect -- key-prop reset would remount mid-batch and orphan the in-flight relocate loop
  useEffect(() => {
    if (batchRunning) return;
    setSavedLayout(configLayout);
    setSavedCustomPath(configCustomPath);
  }, [configLayout, configCustomPath, batchRunning]);

  const layoutInputs = {
    ...device,
    layout,
    projectPath,
    customPath: customPath.trim() || null,
  };

  // Custom layout with no folder picked yet has no resolvable
  // destination. Without this guard, worktreeBaseFor falls back to
  // managed-root and we'd compute a misleading toMove diff.
  const customMissing = layout === "custom" && !customPath.trim();

  // Non-primary worktrees only. The primary checkout sits at projectPath
  // and can't be moved. Externals can't be moved either: `git worktree
  // move` works only on managed worktrees we created.
  const movable = worktrees.filter(isManagedWorktree);

  const proposedFor = (worktree: Worktree): string =>
    worktreePathFor(layoutInputs, worktree.name);

  const toMove = customMissing
    ? []
    : movable.filter((w) => proposedFor(w) !== w.path);

  const layoutChanged =
    layout !== savedLayout || customPath.trim() !== savedCustomPath.trim();

  const validateCustomPath = (): string | null => {
    if (layout !== "custom") return null;
    const trimmed = customPath.trim();
    if (!trimmed) return "Path is required for a custom layout.";
    if (!trimmed.startsWith("/")) return "Path must be absolute.";
    return null;
  };

  const canSubmit =
    (layoutChanged || toMove.length > 0) && !batchRunning && !customMissing;

  const handleApply = async () => {
    const validationError = validateCustomPath();
    if (validationError) {
      setCustomPathError(validationError);
      return;
    }
    setCustomPathError(null);

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
        await write.mutateAsync({ projectId, config: nextConfig });
        setSavedLayout(layout);
        setSavedCustomPath(nextCustomPath);
        return true;
      } catch {
        // useShigomoriWrite already surfaces an error toast via its meta.
        return false;
      }
    };

    const queue = toMove.map((w) => ({
      worktree: w,
      destination: proposedFor(w),
    }));
    await runBatch(
      queue,
      (q) => q.worktree.id,
      async ({ worktree, destination }) => {
        await relocate.mutateAsync({
          projectId,
          worktreeId: worktree.id,
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
      customPathError={customPathError}
      onOpenPicker={() => setPickerOpen(true)}
      toMove={toMove.map((worktree) => ({
        worktree,
        destination: proposedFor(worktree),
      }))}
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
              if (customPathError) setCustomPathError(null);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )
      }
    />
  );
}
