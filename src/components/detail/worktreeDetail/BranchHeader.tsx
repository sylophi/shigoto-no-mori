import { useLayoutEffect, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
  Check,
  ChevronsUpDown,
  Loader2,
  Pencil,
  Search,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { useBranches } from "@/hooks/useBranches";
import {
  useCheckoutBranch,
  useRenameBranch,
  useWorktrees,
} from "@/hooks/useWorktrees";
import { type BranchEntry, scoreMatch } from "@/components/ui/branch-combobox";
import { sanitizeBranchName } from "@shared/branches";
import { isRealBranch, type Worktree } from "@shared/schemas";
import { PullRequestBadge } from "../PullRequestBadge";

// A hidden natural-width duplicate of the row decides whether the PR
// title fits without clipping the branch. The measurer is independent
// of the visible `showTitle` state, so the decision can't oscillate as
// the layout flips.
export function BranchHeaderRow({ worktree }: { worktree: Worktree }) {
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
          onChange={(e) => setDraft(sanitizeBranchName(e.target.value))}
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
