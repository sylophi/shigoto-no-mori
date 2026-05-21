import { useState } from "react";
import { ArrowRight, Info } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { ErrorBanner } from "@/components/ui/error-banner";
import { type RowStatus, RowStatusBadge } from "@/components/ui/row-status";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { useShigomoriWrite } from "@/hooks/useShigomoriWrite";
import { useRelocateWorktree, useWorktrees } from "@/hooks/useWorktrees";
import { worktreeLocationRoute } from "@/router";
import type {
  ShigomoriConfig,
  Worktree,
  WorktreeLayout,
} from "@shared/schemas";
import { worktreePathFor } from "@shared/worktreeLayout";

interface LayoutOption {
  value: WorktreeLayout;
  label: string;
  description: string;
  recommended?: boolean;
}

const LAYOUT_OPTIONS: LayoutOption[] = [
  {
    value: "managed-root",
    label: "Managed root",
    description: "All projects' worktrees live in one place. Easy to nuke.",
    recommended: true,
  },
  {
    value: "in-project",
    label: "In project",
    description:
      "Worktrees live inside the primary at .shigomori/worktrees/. Useful for tools (Turbopack, etc.) that walk up to a workspace root.",
  },
  {
    value: "custom",
    label: "Custom path",
    description:
      "Pick your own directory. Not recommended — can collide with other repos and complicates external-vs-managed detection.",
  },
];

export function WorktreeLocation() {
  const { projectId } = worktreeLocationRoute.useParams();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const { data: worktrees = [], isLoading: worktreesLoading } =
    useWorktrees(projectId);
  const { data: config, isLoading: configLoading } =
    useShigomoriConfig(projectId);
  const { data: resolvedDefaultBranch, isLoading: branchLoading } =
    useDefaultBranch(projectId);

  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const formReady =
    !configLoading &&
    !worktreesLoading &&
    !branchLoading &&
    !!runtime &&
    !!resolvedDefaultBranch;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">
            Worktree location
          </h1>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-3xl flex-col gap-6">
          {!formReady ? (
            <LocationSkeleton />
          ) : (
            <LocationForm
              projectId={projectId}
              projectPath={project.path}
              shigomoriRoot={runtime.shigomoriRoot}
              home={runtime.homedir}
              worktrees={worktrees}
              config={config ?? null}
              resolvedDefaultBranch={resolvedDefaultBranch}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LocationSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full" />
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}

interface LocationFormProps {
  projectId: string;
  projectPath: string;
  shigomoriRoot: string;
  home: string;
  worktrees: Worktree[];
  config: ShigomoriConfig | null;
  resolvedDefaultBranch: string;
}

function LocationForm({
  projectId,
  projectPath,
  shigomoriRoot,
  home,
  worktrees,
  config,
  resolvedDefaultBranch,
}: LocationFormProps) {
  const navigate = useNavigate();
  const write = useShigomoriWrite();
  const relocate = useRelocateWorktree();

  const savedLayout: WorktreeLayout = config?.worktreeLayout ?? "managed-root";
  const savedCustomPath = config?.customWorktreePath ?? "";

  const [layout, setLayout] = useState<WorktreeLayout>(savedLayout);
  const [customPath, setCustomPath] = useState<string>(savedCustomPath);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [status, setStatus] = useState<Map<string, RowStatus>>(new Map());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchDone, setBatchDone] = useState(false);

  const layoutInputs = {
    layout,
    projectPath,
    shigomoriRoot,
    customPath: customPath.trim() || null,
  };

  // Non-primary worktrees only -- the primary checkout sits at projectPath
  // and can't be moved. Externals can't be moved either: `git worktree
  // move` works only on managed worktrees we created.
  const movable = worktrees.filter((w) => !w.isPrimary && !w.isExternal);

  const proposedFor = (worktree: Worktree): string =>
    worktreePathFor(layoutInputs, worktree.name);

  const toMove = movable.filter((w) => proposedFor(w) !== w.path);

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
    (layoutChanged || toMove.length > 0) && !batchRunning && !batchDone;

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
      }
    } catch {
      // useShigomoriWrite already surfaces an error toast via its meta.
      setBatchRunning(false);
      return;
    }

    if (toMove.length === 0) {
      setBatchRunning(false);
      setBatchDone(true);
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
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        await relocate.mutateAsync({
          projectId,
          worktreeId: worktree.id,
          destinationPath: destination,
        });
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
    setBatchDone(true);
  };

  const submitLabel = batchRunning ? "Moving…" : "Move";

  return (
    <>
      <fieldset className="space-y-2" disabled={batchRunning || batchDone}>
        <legend className="sr-only">Worktree location</legend>
        {LAYOUT_OPTIONS.map((opt) => {
          const checked = layout === opt.value;
          const previewPath =
            opt.value === "custom" && !customPath.trim()
              ? "/your/custom/path/<name>"
              : tildify(
                  worktreePathFor(
                    {
                      layout: opt.value,
                      projectPath,
                      shigomoriRoot,
                      customPath:
                        opt.value === "custom"
                          ? customPath.trim() || null
                          : null,
                    },
                    "<name>",
                  ),
                  home,
                );
          return (
            <label
              key={opt.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 text-sm transition-colors",
                checked
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent/30",
              )}
            >
              <input
                type="radio"
                name="worktree-layout"
                value={opt.value}
                checked={checked}
                onChange={() => setLayout(opt.value)}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{opt.label}</span>
                  {opt.recommended && (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      recommended
                    </span>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {opt.description}
                </p>
                <p
                  className="truncate font-mono text-xs text-foreground/70 select-text"
                  title={previewPath}
                >
                  {previewPath}
                </p>
                {opt.value === "custom" && checked && (
                  <div className="space-y-1 pt-1">
                    <input
                      type="text"
                      value={customPath}
                      onChange={(e) => {
                        setCustomPath(e.target.value);
                        if (customPathError) setCustomPathError(null);
                      }}
                      placeholder="/absolute/path/to/worktrees"
                      className={cn(
                        "w-full rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none transition-colors focus:ring-2 focus:ring-ring/30",
                        customPathError
                          ? "border-destructive focus:border-destructive"
                          : "border-input focus:border-ring",
                      )}
                    />
                    {customPathError && (
                      <p className="text-xs text-destructive">
                        {customPathError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </fieldset>

      {toMove.length > 0 && !batchDone && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 select-text dark:text-amber-300">
          <p className="text-[11px] font-semibold tracking-wide uppercase">
            Heads up
          </p>
          <p className="mt-2 leading-relaxed">
            {toMove.length === 1
              ? "1 worktree will move to the new location. "
              : `${toMove.length} worktrees will move to the new location. `}
            Uncommitted changes and untracked files are preserved. Open editors,
            terminals, and IDE projects pointed at the old paths will need to be
            reopened.
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

      {toMove.length === 0 && !batchDone && (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          <Info aria-hidden className="size-4 shrink-0" />
          <span>
            {movable.length === 0
              ? "No managed worktrees yet — the layout setting will apply to new ones."
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
          {batchDone ? "Close" : "Cancel"}
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
    </>
  );
}

interface RelocateRowProps {
  worktree: Worktree;
  destination: string;
  status: RowStatus;
  home: string | null;
  isLast: boolean;
}

function RelocateRow({
  worktree,
  destination,
  status,
  home,
  isLast,
}: RelocateRowProps) {
  const fromPath = tildify(worktree.path, home);
  const toPath = tildify(destination, home);
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-3 py-3 text-sm",
        !isLast && "border-b border-border",
      )}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 truncate font-mono select-text",
              worktree.detached && "text-muted-foreground",
            )}
            title={
              worktree.detached
                ? "Detached HEAD (commit hash)"
                : worktree.branch
            }
          >
            {worktree.branch}
          </span>
          {worktree.detached && (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              detached
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span
            className="min-w-0 truncate text-muted-foreground select-text"
            title={worktree.path}
          >
            {fromPath}
          </span>
          <ArrowRight
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground/60"
          />
          <span
            className="min-w-0 truncate text-foreground/80 select-text"
            title={destination}
          >
            {toPath}
          </span>
        </div>
        {status.kind === "error" && (
          <p className="text-xs text-destructive select-text">
            {status.message}
          </p>
        )}
      </div>
      <RowStatusBadge
        status={status}
        labels={{ running: "Moving", done: "Moved", error: "Move failed" }}
      />
    </div>
  );
}
