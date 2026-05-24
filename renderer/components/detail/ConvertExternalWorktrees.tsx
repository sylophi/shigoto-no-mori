import { useState } from "react";
import { FileDiff } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { BranchLabel } from "@/components/ui/branch-label";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { ErrorBanner } from "@/components/ui/error-banner";
import { type RowStatus, RowStatusBadge } from "@/components/ui/row-status";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import {
  useConvertExternalWorktree,
  useWorktrees,
} from "@/hooks/worktrees/useWorktrees";
import { convertExternalRoute } from "@/router";
import { sanitizeBranchForPath } from "@shared/branches";
import type { Worktree } from "@shared/schemas";
import { worktreePathFor } from "@shared/worktreeLayout";

export function ConvertExternalWorktrees() {
  const { projectId } = convertExternalRoute.useParams();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const { data: worktrees = [], isLoading } = useWorktrees(projectId);
  const { data: config } = useShigomoriConfig(projectId);
  const convert = useConvertExternalWorktree();

  const project = projects.find((p) => p.id === projectId);
  const externals = worktrees.filter((w) => w.isExternal && !w.isPrimary);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Map<string, RowStatus>>(new Map());
  const [batchRunning, setBatchRunning] = useState(false);

  if (!project) {
    return <CenteredMessage>Project not found.</CenteredMessage>;
  }

  const home = runtime?.homedir ?? null;

  // For detached HEADs `worktree.branch` is a short SHA -- pass it
  // through unchanged so the managed worktree gets a hash-named dir.
  // (isRealBranch only filters the UNKNOWN_BRANCH sentinel, which we
  // never see here.)
  const proposedName = (worktree: Worktree): string =>
    worktree.detached
      ? worktree.branch
      : sanitizeBranchForPath(worktree.branch);
  const proposedPath = (worktree: Worktree): string => {
    if (!runtime) return "";
    return tildify(
      worktreePathFor(
        {
          layout: config?.worktreeLayout ?? "managed-root",
          projectPath: project.path,
          shigomoriRoot: runtime.shigomoriRoot,
          customPath: config?.customWorktreePath ?? null,
        },
        proposedName(worktree),
      ),
      home,
    );
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    setBatchRunning(true);
    // Snapshot the selection so toggles during the run don't drift it.
    const queue = externals.filter((w) => selected.has(w.id));
    setStatus(new Map(queue.map((w) => [w.id, { kind: "running" as const }])));
    let lastSuccess: Worktree | null = null;
    for (const wt of queue) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        const result = await convert.mutateAsync({
          projectId: project.id,
          worktreeId: wt.id,
        });
        lastSuccess = result.worktree;
        setStatus((prev) => {
          const next = new Map(prev);
          next.set(wt.id, { kind: "done" });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus((prev) => {
          const next = new Map(prev);
          next.set(wt.id, { kind: "error", message });
          return next;
        });
      }
    }
    setBatchRunning(false);
    setSelected(new Set());

    // One success? Drop the user into it. Multiple successes? Stay on the
    // page so they can see what happened with the rest.
    if (lastSuccess && queue.length === 1) {
      void navigate({
        to: "/projects/$projectId/worktrees/$worktreeId",
        params: { projectId: project.id, worktreeId: lastSuccess.id },
      });
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

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
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

              <div className="overflow-hidden rounded-md border border-border">
                {externals.map((wt, idx) => (
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
                    isLast={idx === externals.length - 1}
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

interface ConvertRowProps {
  worktree: Worktree;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  indeterminateHeader: boolean;
  proposedPath: string;
  home: string | null;
  onToggle: () => void;
  isLast: boolean;
}

function ConvertRow({
  worktree,
  checked,
  status,
  disabled,
  proposedPath,
  home,
  onToggle,
  isLast,
}: ConvertRowProps) {
  const detached = worktree.detached;
  const dirty = worktree.changedCount > 0;
  const oldPath = tildify(worktree.path, home);
  const interactive = !disabled && status.kind !== "done";

  return (
    <label
      className={cn(
        "group flex items-start gap-3 px-3 py-3 text-sm",
        !isLast && "border-b border-border",
        disabled && "opacity-70",
        interactive && "cursor-pointer",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={!interactive}
        className="mt-1 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 truncate font-mono select-text"
            title={detached ? "Detached HEAD (commit hash)" : worktree.branch}
          >
            <BranchLabel branch={worktree.branch} detached={detached} />
          </span>
          {dirty && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title="Uncommitted changes will be wiped"
            >
              <FileDiff aria-hidden className="size-3" />
              {worktree.changedCount} uncommitted
            </span>
          )}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-xs">
          <dt className="text-muted-foreground/60">from</dt>
          <dd
            className="min-w-0 truncate text-muted-foreground select-text"
            title={worktree.path}
          >
            {oldPath}
          </dd>
          <dt className="text-muted-foreground/60">to</dt>
          <dd
            className="min-w-0 truncate text-foreground/80 select-text"
            title={proposedPath}
          >
            {proposedPath}
          </dd>
        </dl>
        {status.kind === "error" && (
          <p className="text-xs text-destructive select-text">
            {status.message}
          </p>
        )}
      </div>
      <RowStatusBadge
        status={status}
        labels={{
          running: "Converting",
          done: "Converted",
          error: "Conversion failed",
        }}
      />
    </label>
  );
}
