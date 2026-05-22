import { useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { SectionHeading } from "@/components/ui/section-heading";
import { PathSpan } from "@/components/ui/path-span";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { cn } from "@/lib/utils";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/useConfirmTwice";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useDeleteWorktree, useWorktrees } from "@/hooks/useWorktrees";
import { worktreeRoute } from "@/router";
import {
  scriptKey,
  scriptRuns,
  slotToParam,
  useScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import { LauncherRow } from "./LauncherRow";
import { ScriptsSection } from "./ScriptsSection";
import { BranchHeaderRow } from "./worktreeDetail/BranchHeader";
import { CommitsSection } from "./worktreeDetail/CommitsSection";
import { NotesSection } from "./worktreeDetail/NotesSection";
import type { CleanupError, Project, Worktree } from "@shared/schemas";

function deleteButtonLabel(busy: boolean, armed: boolean): string {
  if (busy) return "Deleting…";
  return armed ? "Confirm delete?" : "Delete worktree";
}

export function WorktreeDetail() {
  const { projectId, worktreeId } = worktreeRoute.useParams();
  const { data: projects = [] } = useProjects();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  const worktree = worktrees.find((w) => w.id === worktreeId);

  if (!worktree || !project) {
    return <CenteredMessage>Worktree not found.</CenteredMessage>;
  }

  return (
    <WorktreeDetailInner
      worktree={worktree}
      project={project}
      siblings={worktrees}
    />
  );
}

interface InnerProps {
  worktree: Worktree;
  project: Project;
  siblings: Worktree[];
}

// Split from WorktreeDetail so per-worktree hooks (teardown state,
// deletion phase) only attach when worktree+project resolved. Avoids
// short-lived subscriptions on empty keys.
function WorktreeDetailInner({ worktree, project, siblings }: InnerProps) {
  const navigate = useNavigate();
  const { data: runtime } = useRuntimeInfo();
  const deleteMutation = useDeleteWorktree();
  const { armed: confirmDelete, trigger: confirmDeleteTrigger } =
    useConfirmTwice(CONFIRM_QUICK_MS);
  const [needsForce, setNeedsForce] = useState(false);
  const [cleanupError, setCleanupError] = useState<CleanupError | null>(null);

  // Derive limbo state from script-runs: any cleanup-tier script
  // currently running indicates we're mid-cleanup; otherwise if the
  // mutation is in flight we're in the remove phase.
  const teardownKey = scriptKey(worktree.projectId, worktree.id, {
    kind: "teardown",
  });
  const releaseKey = scriptKey(worktree.projectId, worktree.id, {
    kind: "portPool",
    phase: "release",
  });
  const teardownState = useScriptRunState(teardownKey);
  const releaseState = useScriptRunState(releaseKey);
  const home = runtime?.homedir ?? null;

  const cleanupRunning =
    teardownState.status === "running" ||
    teardownState.status === "starting" ||
    releaseState.status === "running" ||
    releaseState.status === "starting";
  const busy = deleteMutation.isPending;
  const inLimbo = cleanupRunning || busy;

  // Tracks the flags from the most recent delete attempt so that the
  // retry/skip affordances on a cleanup failure carry the user's
  // original intent (notably: a force-delete that hit a cleanup error
  // should stay force on retry/skip, since the worktree is still dirty).
  const lastDeleteOptsRef = useRef<{ force?: boolean }>({});

  const runDelete = (opts: { force?: boolean; skipCleanup?: boolean } = {}) => {
    if (!opts.skipCleanup) {
      lastDeleteOptsRef.current = { force: opts.force };
    }
    setCleanupError(null);
    deleteMutation.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        ...opts,
      },
      {
        onSuccess: (data) => {
          if (data.ok) {
            // Prefer the sibling above so the user's eye stays in place.
            const index = siblings.findIndex((w) => w.id === worktree.id);
            const next =
              index >= 0
                ? (siblings[index - 1] ?? siblings[index + 1])
                : undefined;
            if (next) {
              void navigate({
                to: "/projects/$projectId/worktrees/$worktreeId",
                params: { projectId: project.id, worktreeId: next.id },
                replace: true,
              });
            } else {
              void navigate({ to: "/", replace: true });
            }
          } else {
            setCleanupError(data.cleanupError);
          }
        },
        onError: () => {
          setNeedsForce(true);
        },
      },
    );
  };

  const handleDelete = () => {
    confirmDeleteTrigger(() => runDelete());
  };

  const handleForceDelete = () => {
    runDelete({ force: true });
  };

  const cancelForce = () => {
    setNeedsForce(false);
    deleteMutation.reset();
  };

  const handleRetryCleanup = () => runDelete(lastDeleteOptsRef.current);
  const handleSkipCleanup = () =>
    runDelete({ ...lastDeleteOptsRef.current, skipCleanup: true });
  const handleCancelCleanupError = () => setCleanupError(null);
  const handleCancelCleanup = () => {
    if (teardownState.runId) {
      void scriptRuns.cancel(teardownKey);
    }
    if (releaseState.runId) {
      void scriptRuns.cancel(releaseKey);
    }
  };

  const openCleanupConsole = () => {
    let slot: ScriptSlot;
    if (cleanupError) {
      slot =
        cleanupError.phase === "teardown"
          ? { kind: "teardown" }
          : { kind: "portPool", phase: "release" };
    } else if (releaseState.runId) {
      slot = { kind: "portPool", phase: "release" };
    } else if (teardownState.runId) {
      slot = { kind: "teardown" };
    } else {
      return;
    }
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
      params: {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        scriptKey: slotToParam(slot),
      },
    });
  };

  // Decide which limbo phase label to show -- release runs before
  // teardown, then the actual git remove.
  const limboLabel = (() => {
    if (
      releaseState.status === "running" ||
      releaseState.status === "starting"
    ) {
      return releaseState.cancelling
        ? "Stopping port-pool release..."
        : "Releasing ports...";
    }
    if (
      teardownState.status === "running" ||
      teardownState.status === "starting"
    ) {
      return teardownState.cancelling
        ? "Stopping teardown..."
        : "Tearing down...";
    }
    return "Removing worktree...";
  })();
  const cleanupCancelling = teardownState.cancelling || releaseState.cancelling;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2 border-b border-border px-6 pt-7 pb-5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/projects/$projectId/configure",
                params: { projectId: worktree.projectId },
              })
            }
            className="shrink-0 rounded transition-colors hover:text-foreground"
            title={`Configure ${project.name}`}
          >
            {project.name}
          </button>
          <span aria-hidden className="text-muted-foreground/40">
            /
          </span>
          <PathSpan
            path={worktree.path}
            home={home}
            className="min-w-0 flex-1 truncate font-mono"
          />
          <WorktreeKindIcon worktree={worktree} />
        </div>
        <BranchHeaderRow worktree={worktree} />
      </header>

      {inLimbo && (
        <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-6 py-2 text-sm">
          <Loader2
            aria-hidden
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {limboLabel}
          </span>
          {cleanupRunning && (
            <Button
              variant="ghost"
              size="xs"
              onClick={openCleanupConsole}
              className="shrink-0"
            >
              View output
            </Button>
          )}
        </div>
      )}

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-6 py-6",
          inLimbo && "pointer-events-none opacity-50",
        )}
        aria-disabled={inLimbo}
      >
        <div className="flex max-w-4xl flex-col gap-10">
          <section className="space-y-3">
            <SectionHeading>Launch</SectionHeading>
            <LauncherRow worktree={worktree} />
          </section>

          <CommitsSection worktree={worktree} />

          <section className="space-y-3">
            <SectionHeading>Scripts</SectionHeading>
            <ScriptsSection worktree={worktree} />
          </section>

          <NotesSection worktree={worktree} />
        </div>
      </div>

      <footer className="flex h-[38px] items-center gap-3 border-t border-border bg-card px-6">
        {cleanupError ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive select-text">
              {cleanupError.phase === "teardown"
                ? "Teardown didn't complete cleanly"
                : "Port-pool release didn't complete cleanly"}{" "}
              (exit{" "}
              {cleanupError.exitCode === null
                ? "errored"
                : cleanupError.exitCode}
              ).
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleCancelCleanupError}
            >
              Cancel
            </Button>
            <Button variant="ghost" size="xs" onClick={openCleanupConsole}>
              View output
            </Button>
            <Button variant="ghost" size="xs" onClick={handleRetryCleanup}>
              Retry
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleSkipCleanup}
            >
              <Trash2 />
              Skip cleanup
            </Button>
          </>
        ) : needsForce ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive select-text">
              {deleteMutation.error?.message ?? "Has uncommitted changes."}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={cancelForce}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              onClick={handleForceDelete}
            >
              <Trash2 />
              {busy ? "Deleting..." : "Force delete"}
            </Button>
          </>
        ) : cleanupRunning ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleCancelCleanup}
            disabled={cleanupCancelling}
            className="ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
            {cleanupCancelling ? "Stopping..." : "Stop cleanup"}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              "ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive",
              confirmDelete && "bg-destructive/10",
            )}
            disabled={busy || worktree.isPrimary}
            onClick={handleDelete}
            title={
              worktree.isPrimary
                ? "Repo root cannot be deleted"
                : confirmDelete
                  ? "Click again to confirm"
                  : "Delete worktree"
            }
          >
            <Trash2 />
            {deleteButtonLabel(busy, confirmDelete)}
          </Button>
        )}
      </footer>
    </div>
  );
}
