import { useRef, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
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
} from "@/store/scriptRuns";
import {
  useWorktreeDeletion,
  worktreeDeletions,
} from "@/store/worktreeDeletions";
import { LauncherRow } from "./LauncherRow";
import { ScriptsSection } from "./ScriptsSection";
import { type BranchEntry, scoreMatch } from "@/components/ui/branch-combobox";
import {
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
  const { projectId, worktreeName } = worktreeRoute.useParams();
  const { data: projects = [] } = useProjects();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  const worktree = worktrees.find((w) => w.name === worktreeName);

  if (!worktree || !project) {
    return <CenteredMessage>Worktree not found.</CenteredMessage>;
  }

  return <WorktreeDetailInner worktree={worktree} project={project} />;
}

interface InnerProps {
  worktree: Worktree;
  project: Project;
}

// Split from WorktreeDetail so per-worktree hooks (teardown state,
// deletion phase) only attach when worktree+project resolved. Avoids
// short-lived subscriptions on empty keys.
function WorktreeDetailInner({ worktree, project }: InnerProps) {
  const navigate = useNavigate();
  const { data: runtime } = useRuntimeInfo();
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const deleteMutation = useDeleteWorktree();
  const { armed: confirmDelete, trigger: confirmDeleteTrigger } =
    useConfirmTwice(3_000);
  const [needsForce, setNeedsForce] = useState(false);
  const [teardownError, setTeardownError] = useState<string | null>(null);
  const deletionPhase = useWorktreeDeletion(worktree.id);
  const teardownKey = scriptKey(worktree.projectId, worktree.id, {
    kind: "teardown",
  });
  const teardownState = useScriptRunState(teardownKey);
  const home = runtime?.homedir ?? null;

  const teardownConfigured =
    (config?.scripts?.teardown ?? "").trim().length > 0;
  const inLimbo = deletionPhase !== undefined;
  const busy = deleteMutation.isPending || inLimbo;

  const removeNow = (force: boolean) => {
    worktreeDeletions.set(worktree.id, "removing");
    deleteMutation.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id, force },
      {
        onSuccess: () => {
          worktreeDeletions.clear(worktree.id);
          void navigate({ to: "/" });
        },
        onError: () => {
          worktreeDeletions.clear(worktree.id);
          setNeedsForce(true);
        },
      },
    );
  };

  const runTeardownThenRemove = async () => {
    setTeardownError(null);
    worktreeDeletions.set(worktree.id, "tearingDown");
    try {
      await scriptRuns.start({
        key: teardownKey,
        worktreeId: worktree.id,
        slot: { kind: "teardown" },
        runner: () =>
          window.api.scripts.run({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
            script: "teardown",
          }),
      });
    } catch (err) {
      worktreeDeletions.clear(worktree.id);
      setTeardownError(err instanceof Error ? err.message : String(err));
      return;
    }
    const code = await scriptRuns.awaitExit(teardownKey);
    if (code !== 0) {
      worktreeDeletions.clear(worktree.id);
      setTeardownError(
        code === null
          ? "Teardown script errored"
          : `Teardown exited with code ${code}`,
      );
      return;
    }
    removeNow(false);
  };

  const handleDelete = () => {
    confirmDeleteTrigger(() => {
      if (teardownConfigured) {
        void runTeardownThenRemove();
      } else {
        removeNow(false);
      }
    });
  };

  const handleForceDelete = () => {
    removeNow(true);
  };

  const cancelForce = () => {
    setNeedsForce(false);
    deleteMutation.reset();
  };

  const handleRetryTeardown = () => {
    void runTeardownThenRemove();
  };

  const handleSkipTeardown = () => {
    setTeardownError(null);
    removeNow(false);
  };

  const handleCancelTeardownError = () => {
    setTeardownError(null);
  };

  const handleCancelTeardown = () => {
    void scriptRuns.cancel(teardownKey);
  };

  const openTeardownConsole = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeName/scripts/$scriptKey",
      params: {
        projectId: worktree.projectId,
        worktreeName: worktree.name,
        scriptKey: slotToParam({ kind: "teardown" }),
      },
    });

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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <BranchTitle worktree={worktree} />
          </div>
          {worktree.changedCount > 0 && (
            <button
              type="button"
              onClick={() =>
                void navigate({
                  to: "/projects/$projectId/worktrees/$worktreeName/diff",
                  params: {
                    projectId: worktree.projectId,
                    worktreeName: worktree.name,
                  },
                })
              }
              title="View uncommitted changes"
              className="group/diff tabular inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-xs text-amber-500 transition-colors hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-amber-500"
            >
              <FileDiff aria-hidden className="size-3.5" />
              {worktree.changedCount}{" "}
              {worktree.changedCount === 1 ? "file" : "files"} changed
              <ChevronRight
                aria-hidden
                className="size-3.5 opacity-60 transition-transform group-hover/diff:translate-x-0.5"
              />
            </button>
          )}
        </div>
      </header>

      {inLimbo && (
        <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-6 py-2 text-sm">
          <Loader2
            aria-hidden
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {deletionPhase === "tearingDown"
              ? teardownState.cancelling
                ? "Stopping teardown…"
                : "Tearing down…"
              : "Removing worktree…"}
          </span>
          {deletionPhase === "tearingDown" && (
            <Button
              variant="ghost"
              size="xs"
              onClick={openTeardownConsole}
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
        <div className="flex max-w-4xl flex-col gap-5">
          <section className="space-y-3">
            <SectionHeading>Launch</SectionHeading>
            <LauncherRow worktree={worktree} />
          </section>

          <Separator />

          <CommitsSection worktree={worktree} />

          <Separator />

          <section className="space-y-3">
            <SectionHeading>Scripts</SectionHeading>
            <ScriptsSection worktree={worktree} />
          </section>

          <Separator />

          <NotesSection worktree={worktree} />
        </div>
      </div>

      <footer className="flex h-[38px] items-center gap-3 border-t border-border bg-card px-6">
        {teardownError ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive select-text">
              {teardownError}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleCancelTeardownError}
            >
              Cancel
            </Button>
            <Button variant="ghost" size="xs" onClick={openTeardownConsole}>
              View output
            </Button>
            <Button variant="ghost" size="xs" onClick={handleRetryTeardown}>
              Retry teardown
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleSkipTeardown}
            >
              <Trash2 />
              Skip teardown
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
              {busy ? "Deleting…" : "Force delete"}
            </Button>
          </>
        ) : inLimbo && deletionPhase === "tearingDown" ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleCancelTeardown}
            disabled={teardownState.cancelling}
            className="ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
            {teardownState.cancelling ? "Stopping…" : "Stop teardown"}
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

  const saved = config?.notes?.[worktree.name] ?? "";
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
      delete nextNotes[worktree.name];
    } else {
      nextNotes[worktree.name] = next;
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
  const last = worktree.lastCommit;
  return (
    <section className="space-y-3">
      <SectionHeading>Last commit</SectionHeading>
      {last ? (
        <CommitRow commit={last} />
      ) : (
        <div className="text-sm text-muted-foreground">No commits yet.</div>
      )}
    </section>
  );
}

function CommitRow({ commit }: { commit: CommitSummary }) {
  return (
    <div className="space-y-1 select-text">
      <div className="text-sm">{commit.subject}</div>
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
          <span className="truncate text-xs text-destructive">
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
              <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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
