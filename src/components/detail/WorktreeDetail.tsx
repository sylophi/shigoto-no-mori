import { useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
  Check,
  ChevronsUpDown,
  ExternalLink,
  House,
  Loader2,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/projectPaths";
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
import { LauncherRow } from "./LauncherRow";
import { ScriptsPanel } from "./ScriptsPanel";
import { type BranchEntry, scoreMatch } from "@/components/ui/branch-combobox";
import {
  type CommitSummary,
  isRealBranch,
  type Worktree,
} from "@shared/schemas";

function deleteButtonLabel(busy: boolean, armed: boolean): string {
  if (busy) return "Deleting…";
  return armed ? "Confirm delete?" : "Delete worktree";
}

export function WorktreeDetail() {
  const { projectId, worktreeName } = worktreeRoute.useParams();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const project = projects.find((p) => p.id === projectId);
  const worktree = worktrees.find((w) => w.name === worktreeName);

  const { data: runtime } = useRuntimeInfo();
  const deleteMutation = useDeleteWorktree();
  const { armed: confirmDelete, trigger: confirmDeleteTrigger } =
    useConfirmTwice(3_000);
  const [needsForce, setNeedsForce] = useState(false);
  const home = runtime?.homedir ?? null;

  if (!worktree || !project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Worktree not found.
      </div>
    );
  }

  const busy = deleteMutation.isPending;

  const handleDelete = () => {
    confirmDeleteTrigger(() => {
      deleteMutation.mutate(
        {
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          force: false,
        },
        {
          onSuccess: () => void navigate({ to: "/" }),
          onError: () => setNeedsForce(true),
        },
      );
    });
  };

  const handleForceDelete = () => {
    deleteMutation.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        force: true,
      },
      { onSuccess: () => void navigate({ to: "/" }) },
    );
  };

  const cancelForce = () => {
    setNeedsForce(false);
    deleteMutation.reset();
  };

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
          <span className="min-w-0 truncate font-mono">
            {tildify(worktree.path, home)}
          </span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <BranchTitle worktree={worktree} />
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {worktree.isPrimary ? (
                <House
                  className="size-3 shrink-0 text-muted-foreground/70"
                  aria-label="Repo root"
                />
              ) : worktree.isExternal ? (
                <ExternalLink
                  className="size-3 shrink-0 text-muted-foreground/70"
                  aria-label="External worktree"
                />
              ) : null}
              <span className="truncate">{worktree.name}</span>
            </div>
          </div>
          <StatusPills worktree={worktree} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
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
            <ScriptsPanel worktree={worktree} />
          </section>

          <Separator />

          <NotesSection worktree={worktree} />
        </div>
      </div>

      <footer className="flex h-[38px] items-center gap-3 border-t border-border bg-card px-6">
        {needsForce ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-destructive">
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
        ) : (
          <>
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground select-text"
              title={worktree.path}
            >
              {tildify(worktree.path, home)}
            </span>
            {worktree.isPrimary ? (
              <span className="shrink-0 text-xs text-muted-foreground/70">
                Repo root
              </span>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className={cn(
                  "shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive",
                  confirmDelete && "bg-destructive/10",
                )}
                disabled={busy}
                onClick={handleDelete}
                title={
                  confirmDelete ? "Click again to confirm" : "Delete worktree"
                }
              >
                <Trash2 />
                {deleteButtonLabel(busy, confirmDelete)}
              </Button>
            )}
          </>
        )}
      </footer>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
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
    <div className="space-y-1">
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
    <div className="group/branch flex min-w-0 items-center gap-1.5">
      <h1
        ref={titleRef}
        className="min-w-0 truncate font-mono text-2xl font-medium tracking-tight"
      >
        {worktree.branch}
      </h1>
      <button
        type="button"
        onClick={begin}
        aria-label="Rename branch"
        title="Rename branch"
        className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/branch:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
      >
        <Pencil className="size-3.5" />
      </button>
      <BranchSwitcher worktree={worktree} anchorRef={titleRef} />
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
        className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/branch:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[popup-open]:bg-accent data-[popup-open]:text-foreground data-[popup-open]:opacity-100"
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

function StatusPills({ worktree }: { worktree: Worktree }) {
  const pills: { label: string; tone: "neutral" | "warn" }[] = [];
  if (worktree.ahead > 0) {
    pills.push({ label: `↑ ${worktree.ahead}`, tone: "neutral" });
  }
  if (worktree.behind > 0) {
    pills.push({ label: `↓ ${worktree.behind}`, tone: "neutral" });
  }
  if (worktree.changedCount > 0) {
    pills.push({
      label: `${worktree.changedCount} changed`,
      tone: "warn",
    });
  }
  if (pills.length === 0) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-1">
      {pills.map((pill) => (
        <span
          key={pill.label}
          className={cn(
            "tabular inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-xs",
            pill.tone === "neutral" &&
              "border-border bg-card text-muted-foreground",
            pill.tone === "warn" &&
              "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {pill.label}
        </span>
      ))}
    </div>
  );
}

function RelativeDate({ date }: { date: string }) {
  const value = new Date(date);
  const diffMs = Date.now() - value.getTime();
  const diffHours = Math.max(0, Math.round(diffMs / (1000 * 60 * 60)));
  const label =
    diffHours < 1
      ? "just now"
      : diffHours < 24
        ? `${diffHours}h ago`
        : `${Math.round(diffHours / 24)}d ago`;
  return <span title={value.toLocaleString()}>{label}</span>;
}
