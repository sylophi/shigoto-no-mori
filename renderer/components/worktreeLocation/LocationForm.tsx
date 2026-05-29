import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { FolderPickerModal } from "@/components/ui/folder-picker-modal";
import { type RowStatus } from "@/components/ui/row-status";
import { useShigomoriWrite } from "@/hooks/config/useShigomoriWrite";
import { useRelocateWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import type {
  ShigomoriConfig,
  Worktree,
  WorktreeLayout,
} from "@shared/schemas";
import { worktreePathFor } from "@shared/worktreeLayout";
import { LayoutOptionItem, type LayoutOption } from "./LayoutOptionItem";
import { RelocateRow } from "./RelocateRow";

const LAYOUT_OPTIONS: LayoutOption[] = [
  {
    value: "managed-root",
    label: "Managed root",
    description: "Worktrees live under Shigomori's shared root.",
    recommended: true,
  },
  {
    value: "in-project",
    label: "In project",
    description: "Worktrees live inside the primary at .shigomori/worktrees/.",
  },
  {
    value: "custom",
    label: "Custom path",
  },
];

interface LocationFormProps {
  projectId: string;
  projectPath: string;
  shigomoriRoot: string;
  home: string;
  worktrees: Worktree[];
  config: ShigomoriConfig | null;
  resolvedDefaultBranch: string;
}

export function LocationForm({
  projectId,
  projectPath,
  shigomoriRoot,
  home,
  worktrees,
  config,
  resolvedDefaultBranch,
  // react-doctor-disable-next-line react-doctor/prefer-useReducer -- per-field setters are simple; saved* mirrors track persisted state without coupling between fields
}: LocationFormProps) {
  const navigate = useNavigate();
  const write = useShigomoriWrite();
  const relocate = useRelocateWorktree();

  // Mirror the persisted config in local state so we can flip it
  // immediately after a successful save. Reading the config prop
  // directly would lag while the shigomori query refetches, which
  // briefly re-enables the Move button after a batch completes.
  const configLayout = config?.worktreeLayout ?? "managed-root";
  const configCustomPath = config?.customWorktreePath ?? "";
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- savedLayout tracks the last-persisted value, not the prop; updated in handleApply and synced from the prop only when no batch is in flight
  const [savedLayout, setSavedLayout] = useState<WorktreeLayout>(configLayout);
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- savedCustomPath tracks the last-persisted value, not the prop; updated in handleApply and synced from the prop only when no batch is in flight
  const [savedCustomPath, setSavedCustomPath] =
    useState<string>(configCustomPath);

  const [layout, setLayout] = useState<WorktreeLayout>(savedLayout);
  const [customPath, setCustomPath] = useState<string>(savedCustomPath);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [status, setStatus] = useState<Map<string, RowStatus>>(new Map());
  const [batchRunning, setBatchRunning] = useState(false);
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
    layout,
    projectPath,
    shigomoriRoot,
    customPath: customPath.trim() || null,
  };

  // Custom layout with no folder picked yet has no resolvable
  // destination. Without this guard, worktreeBaseFor falls back to
  // managed-root and we'd compute a misleading toMove diff.
  const customMissing = layout === "custom" && !customPath.trim();

  // Non-primary worktrees only -- the primary checkout sits at projectPath
  // and can't be moved. Externals can't be moved either: `git worktree
  // move` works only on managed worktrees we created.
  const movable = worktrees.filter((w) => !w.isPrimary && !w.isExternal);

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
    setBatchRunning(true);

    try {
      if (layoutChanged) {
        // If the project has no on-disk config yet, fall back to the
        // resolved default branch (same source ConfigureProject uses)
        // so we never invent a branch name like "main" on a repo that
        // uses "master" or "trunk".
        const nextConfig: ShigomoriConfig = {
          ...(config ?? { defaultBranch: resolvedDefaultBranch }),
          worktreeLayout: layout,
          customWorktreePath:
            layout === "custom" ? customPath.trim() : undefined,
        };
        await write.mutateAsync({ projectId, config: nextConfig });
        setSavedLayout(layout);
        setSavedCustomPath(layout === "custom" ? customPath.trim() : "");
      }
    } catch {
      // useShigomoriWrite already surfaces an error toast via its meta.
      setBatchRunning(false);
      return;
    }

    if (toMove.length === 0) {
      setBatchRunning(false);
      return;
    }

    const queue = toMove.map((w) => ({
      worktree: w,
      destination: proposedFor(w),
    }));
    setStatus(
      new Map(queue.map((q) => [q.worktree.id, { kind: "running" as const }])),
    );

    for (const { worktree, destination } of queue) {
      const args = {
        projectId,
        worktreeId: worktree.id,
        destinationPath: destination,
      };
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential by design
        await relocate.mutateAsync(args); // oxlint-disable-line no-await-in-loop -- sequential by design
        setStatus((prev) => {
          const next = new Map(prev);
          next.set(worktree.id, { kind: "done" });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus((prev) => {
          const next = new Map(prev);
          next.set(worktree.id, { kind: "error", message });
          return next;
        });
      }
    }

    setBatchRunning(false);
  };

  const submitLabel = batchRunning ? "Moving…" : "Move";

  return (
    <>
      <fieldset className="space-y-2" disabled={batchRunning}>
        <legend className="sr-only">Worktree location</legend>
        {LAYOUT_OPTIONS.map((opt) => (
          <LayoutOptionItem
            key={opt.value}
            option={opt}
            checked={layout === opt.value}
            projectPath={projectPath}
            shigomoriRoot={shigomoriRoot}
            home={home}
            customPath={customPath}
            customPathError={customPathError}
            onSelect={setLayout}
            onOpenPicker={() => setPickerOpen(true)}
          />
        ))}
      </fieldset>

      {toMove.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 select-text dark:text-amber-300">
          <p className="text-[11px] font-semibold tracking-wide uppercase">
            Heads up
          </p>
          <p className="mt-2 leading-relaxed">
            {toMove.length === 1
              ? "1 worktree will move to the new location. "
              : `${toMove.length} worktrees will move to the new location. `}
            Uncommitted changes and untracked files are preserved. Repoint any
            open editors, terminals, or IDE projects to the new paths.
          </p>
        </div>
      )}

      {toMove.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          {toMove.map((wt, idx) => (
            <RelocateRow
              key={wt.id}
              worktree={wt}
              destination={proposedFor(wt)}
              status={status.get(wt.id) ?? { kind: "idle" }}
              home={home}
              isLast={idx === toMove.length - 1}
            />
          ))}
        </div>
      )}

      {toMove.length === 0 && (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          <Info aria-hidden className="size-4 shrink-0" />
          <span>
            {customMissing
              ? "Pick a folder to continue."
              : movable.length === 0
                ? "No managed worktrees yet. The layout setting will apply to new ones."
                : "All managed worktrees already live at this location."}
          </span>
        </div>
      )}

      {write.error && <ErrorBanner>{write.error.message}</ErrorBanner>}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate({ to: "/" })}
          disabled={batchRunning}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleApply()}
          disabled={!canSubmit}
        >
          {submitLabel}
        </Button>
      </div>

      {pickerOpen && (
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
      )}
    </>
  );
}
