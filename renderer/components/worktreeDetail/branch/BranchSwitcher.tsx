import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { useBranches } from "@/hooks/git/useBranches";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useCheckoutBranch } from "@/hooks/worktrees/useWorktreeBranchOps";
import { type BranchEntry } from "@/components/ui/branch-combobox";
import { scoreMatch } from "@/lib/fuzzyMatch";
import { isRealBranch, type Worktree } from "@shared/schemas";

export function BranchSwitcher({
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
  const occupied = new Set<string>();
  for (const w of peerWorktrees) {
    if (w.id !== worktree.id && isRealBranch(w.branch)) occupied.add(w.branch);
  }
  // Local branches always shown; remotes only when no matching local
  // exists. Picking a remote orphan creates a local tracking branch
  // (handled in onValueChange below).
  const localSet = new Set(branches?.local ?? []);
  const all: BranchEntry[] = [];
  for (const name of branches?.local ?? []) {
    if (!occupied.has(name)) all.push({ name, kind: "local" });
  }
  for (const name of branches?.remote ?? []) {
    if (!localSet.has(name.replace(/^[^/]+\//, ""))) {
      all.push({ name, kind: "remote" });
    }
  }
  let sorted: BranchEntry[] = all;
  if (query) {
    const scored: { b: BranchEntry; score: number }[] = [];
    for (const b of all) {
      const score = scoreMatch(query, b.name);
      if (score > 0) scored.push({ b, score });
    }
    scored.sort((a, b) => b.score - a.score);
    sorted = scored.map((x) => x.b);
  }

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
            queryKey: queryKeys.branches(worktree.projectId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.worktrees(worktree.projectId),
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
