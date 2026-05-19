import { useLayoutEffect, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  FileDiff,
  Loader2,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { CopyButton } from "@/components/ui/copy-button";
import { SectionHeading } from "@/components/ui/section-heading";
import { PathSpan } from "@/components/ui/path-span";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { useBranches } from "@/hooks/useBranches";
import { useConfirmTwice } from "@/hooks/useConfirmTwice";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { useShigomoriWrite } from "@/hooks/useShigomoriWrite";
import {
  useCheckoutBranch,
  useDeleteWorktree,
  useRenameBranch,
  useWorktrees,
} from "@/hooks/useWorktrees";
import { worktreeRoute } from "@/router";
import {
  scriptKey,
  scriptRuns,
  slotToParam,
  useScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import { LauncherRow } from "./LauncherRow";
import { PullRequestBadge } from "./PullRequestBadge";
import { ScriptsSection } from "./ScriptsSection";
import { WorktreeSyncPill } from "./WorktreeSyncPill";
import { type BranchEntry, scoreMatch } from "@/components/ui/branch-combobox";
import {
  type CleanupError,
  type CommitSummary,
  isRealBranch,
  type Project,
  type Worktree,
} from "@shared/schemas";

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
    useConfirmTwice(3_000);
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

function NotesSection({ worktree }: { worktree: Worktree }) {
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const { data: resolvedDefaultBranch } = useDefaultBranch(worktree.projectId);
  const write = useShigomoriWrite();

  const saved = config?.notes?.[worktree.id] ?? "";
  const [draft, setDraft] = useState(saved);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  // Re-sync the draft when switching between worktrees or when the
  // config first loads. Tracking the worktree id lets us detect both.
  if (hydratedFor !== worktree.id) {
    setHydratedFor(worktree.id);
    setDraft(saved);
  }

  const commit = () => {
    const next = draft;
    if (next === saved) return;
    if (!resolvedDefaultBranch && !config?.defaultBranch) return;
    const base = config ?? {
      defaultBranch: resolvedDefaultBranch ?? "main",
    };
    const nextNotes = { ...config?.notes };
    if (next.trim().length === 0) {
      delete nextNotes[worktree.id];
    } else {
      nextNotes[worktree.id] = next;
    }
    write.mutate({
      projectId: worktree.projectId,
      config: {
        ...base,
        notes: Object.keys(nextNotes).length > 0 ? nextNotes : undefined,
      },
    });
  };

  const status =
    write.isPending && draft !== saved
      ? "Saving…"
      : write.isSuccess && draft === saved
        ? "Saved"
        : "";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Notes</SectionHeading>
        <span className="text-xs text-muted-foreground/60">{status}</span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
      {write.error && (
        <div className="text-xs text-destructive">{write.error.message}</div>
      )}
    </section>
  );
}

function CommitsSection({ worktree }: { worktree: Worktree }) {
  const navigate = useNavigate();
  const commits = worktree.recentCommits;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Branch</SectionHeading>
        {worktree.changedCount > 0 ? (
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/projects/$projectId/worktrees/$worktreeId/diff",
                params: {
                  projectId: worktree.projectId,
                  worktreeId: worktree.id,
                },
              })
            }
            title="View uncommitted changes"
            className="tabular inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-amber-500 transition-colors hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FileDiff aria-hidden className="size-3.5" />
            {worktree.changedCount}{" "}
            {worktree.changedCount === 1 ? "file" : "files"} changed
            <ChevronRight aria-hidden className="size-3.5 opacity-60" />
          </button>
        ) : (
          <WorktreeSyncPill worktree={worktree} />
        )}
      </div>
      {commits.length === 0 ? (
        <div className="text-sm text-muted-foreground">No commits yet.</div>
      ) : (
        <ul className="space-y-2">
          {commits.map((commit) => (
            <li key={commit.hash}>
              <CommitRow worktree={worktree} commit={commit} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CommitStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  // emerald-500 / rose-500 read close to Pierre's dark/light addition
  // and deletion hues without requiring shadow-DOM theme variables.
  return (
    <span
      aria-label={`${additions} additions, ${deletions} deletions`}
      title={`${additions} additions, ${deletions} deletions`}
      className="tabular inline-flex shrink-0 items-center gap-1.5 font-mono text-xs"
    >
      <span className="text-emerald-500">+{additions}</span>
      <span className="text-rose-500">−{deletions}</span>
    </span>
  );
}

function CommitRow({
  worktree,
  commit,
}: {
  worktree: Worktree;
  commit: CommitSummary;
}) {
  const navigate = useNavigate();
  const onClick = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
      params: {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        hash: commit.hash,
      },
    });
  return (
    <button
      type="button"
      onClick={onClick}
      title="View this commit's diff"
      className="-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="w-full truncate text-sm">{commit.subject}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{commit.hash}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span>{commit.author}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <RelativeDate date={commit.date} />
        </div>
      </div>
      {(commit.additions > 0 || commit.deletions > 0) && (
        <CommitStats
          additions={commit.additions}
          deletions={commit.deletions}
        />
      )}
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/40"
      />
    </button>
  );
}

// A hidden natural-width duplicate of the row decides whether the PR
// title fits without clipping the branch. The measurer is independent
// of the visible `showTitle` state, so the decision can't oscillate as
// the layout flips.
function BranchHeaderRow({ worktree }: { worktree: Worktree }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measurerRef = useRef<HTMLDivElement>(null);
  const [showTitle, setShowTitle] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measurer = measurerRef.current;
    if (!row || !measurer) return;
    const check = () => {
      setShowTitle(measurer.scrollWidth <= row.clientWidth);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    observer.observe(measurer);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={rowRef}
      className="relative flex items-start justify-between gap-3"
    >
      <div className="min-w-0 flex-1">
        <BranchTitle worktree={worktree} />
      </div>
      <PullRequestBadge worktree={worktree} showTitle={showTitle} />
      <div
        ref={measurerRef}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 flex items-start gap-3 whitespace-nowrap"
      >
        <BranchTitleMeasurer branch={worktree.branch} />
        <PullRequestBadge worktree={worktree} showTitle />
      </div>
    </div>
  );
}

// Mimics BranchTitle's outer flex container width without re-mounting
// BranchSwitcher's combobox/portal. The three boxes stand in for the
// pencil/switcher/copy buttons (each is p-1 around a size-3.5 icon, so
// 22px wide). Drift these if BranchTitle's button cluster changes.
function BranchTitleMeasurer({ branch }: { branch: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-2xl font-medium tracking-tight">
        {branch}
      </span>
      <span className="block size-[22px]" />
      <span className="block size-[22px]" />
      <span className="block size-[22px]" />
    </div>
  );
}

function BranchTitle({ worktree }: { worktree: Worktree }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(worktree.branch);
  const rename = useRenameBranch();
  const titleRef = useRef<HTMLHeadingElement>(null);

  const begin = () => {
    // Detached HEAD has no branch to rename — guard against any caller
    // (incl. future keybindings) that bypasses the hidden pencil button.
    if (worktree.detached) return;
    setDraft(worktree.branch);
    rename.reset();
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(worktree.branch);
    rename.reset();
  };
  const commit = () => {
    const next = draft.trim();
    if (!next || next === worktree.branch) {
      cancel();
      return;
    }
    rename.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        newBranch: next,
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: editing
          autoFocus
          value={draft}
          disabled={rename.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-2xl font-medium tracking-tight outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={commit}
          disabled={rename.isPending}
          aria-label="Confirm rename"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={rename.isPending}
          aria-label="Cancel rename"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
        {rename.error && (
          <span className="truncate text-xs text-destructive select-text">
            {rename.error.message}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="group/copy flex min-w-0 items-center gap-1.5">
      <h1
        ref={titleRef}
        className={cn(
          "min-w-0 truncate font-mono text-2xl font-medium tracking-tight",
          worktree.detached && "text-muted-foreground",
        )}
        title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
      >
        {worktree.branch}
      </h1>
      {worktree.detached && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          detached
        </span>
      )}
      {!worktree.detached && (
        <button
          type="button"
          onClick={begin}
          aria-label="Rename branch"
          title="Rename branch"
          className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
      )}
      <BranchSwitcher worktree={worktree} anchorRef={titleRef} />
      <CopyButton
        value={worktree.branch}
        label={worktree.detached ? "Copy commit hash" : "Copy branch name"}
      />
    </div>
  );
}

function BranchSwitcher({
  worktree,
  anchorRef,
}: {
  worktree: Worktree;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const { data: branches, isFetching: branchesFetching } = useBranches(
    worktree.projectId,
  );
  const { data: peerWorktrees = [] } = useWorktrees(worktree.projectId);
  const checkout = useCheckoutBranch();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  // Exclude branches in use by *other* worktrees only; keeping this
  // worktree's own branch lets the popup show it with a check mark.
  const occupied = new Set(
    peerWorktrees
      .filter((w) => w.id !== worktree.id && isRealBranch(w.branch))
      .map((w) => w.branch),
  );
  // Local branches always shown; remotes only when no matching local
  // exists. Picking a remote orphan creates a local tracking branch
  // (handled in onValueChange below).
  const localSet = new Set(branches?.local ?? []);
  const localEntries: BranchEntry[] = (branches?.local ?? [])
    .filter((name) => !occupied.has(name))
    .map((name) => ({ name, kind: "local" as const }));
  const remoteEntries: BranchEntry[] = (branches?.remote ?? [])
    .filter((name) => !localSet.has(name.replace(/^[^/]+\//, "")))
    .map((name) => ({ name, kind: "remote" as const }));
  const all = [...localEntries, ...remoteEntries];
  const sorted: BranchEntry[] = query
    ? all
        .map((b) => ({ b, score: scoreMatch(query, b.name) }))
        .filter((x) => x.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .map((x) => x.b)
    : all;

  return (
    <Combobox.Root
      value={worktree.branch}
      onValueChange={(v) => {
        const next = v as string | null;
        if (!next || next === worktree.branch) return;
        // Remote orphans: strip the remote prefix so `git checkout` DWIMs
        // into a freshly-created local tracking branch instead of
        // detached HEAD on the remote ref.
        const remoteSet = new Set(branches?.remote ?? []);
        const target = remoteSet.has(next)
          ? next.replace(/^[^/]+\//, "")
          : next;
        if (target === worktree.branch) return;
        checkout.mutate({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          branch: target,
        });
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (open) {
          setQuery("");
          checkout.reset();
          void queryClient.invalidateQueries({
            queryKey: ["branches", worktree.projectId],
          });
          void queryClient.invalidateQueries({
            queryKey: ["worktrees", worktree.projectId],
          });
        }
      }}
      autoHighlight
    >
      <Combobox.Trigger
        aria-label="Switch branch"
        title="Switch branch"
        className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[popup-open]:bg-accent data-[popup-open]:text-foreground data-[popup-open]:opacity-100"
      >
        <ChevronsUpDown aria-hidden className="size-3.5" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          anchor={anchorRef}
          sideOffset={6}
          side="bottom"
          align="start"
          className="z-50"
        >
          <Combobox.Popup className="flex max-h-72 w-72 flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/60"
              />
              <Combobox.Input
                placeholder="Switch to branch…"
                className="flex-1 bg-transparent py-2 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
              />
              {branchesFetching && (
                <Loader2
                  aria-label="Syncing branches"
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground/60"
                />
              )}
            </div>
            <Combobox.List className="flex-1 overflow-y-auto p-1">
              {sorted.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No matching branches.
                </div>
              )}
              {sorted.map((entry) => (
                <Combobox.Item
                  key={`${entry.kind}:${entry.name}`}
                  value={entry.name}
                  className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                >
                  <span className="flex-1 truncate font-mono">
                    {entry.name}
                  </span>
                  {entry.name === worktree.branch && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                  {entry.kind === "remote" && (
                    <span className="text-[10px] text-muted-foreground">
                      remote
                    </span>
                  )}
                </Combobox.Item>
              ))}
            </Combobox.List>
            {checkout.error && (
              <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive select-text">
                {checkout.error.message}
              </div>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

function RelativeDate({ date }: { date: string }) {
  const value = new Date(date);
  return (
    <span title={value.toLocaleString()}>
      {formatRelativeTime(value.getTime())}
    </span>
  );
}
