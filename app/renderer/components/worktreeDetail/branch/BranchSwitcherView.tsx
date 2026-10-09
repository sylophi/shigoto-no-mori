import { useEffect, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, Loader2, Search } from "lucide-react";
import { type BranchEntry } from "@/components/shared/BranchComboboxView";
import { rankByScore } from "@/lib/fuzzyMatch";
import { SimpleTooltip } from "@/components/ui/tooltip";

// Switching the worktree's branch, opened from the branch's menu
// (BranchMenuView). BranchSwitcher lists the branches.
export function BranchSwitcherView({
  branch,
  entries,
  fetching,
  onPick,
  anchorRef,
  open,
  onOpenChange,
}: {
  // The worktree's own branch, which the list checks.
  branch: string;
  // The branches it can switch to (BranchSwitcher), local and remote.
  entries: readonly BranchEntry[];
  // A listing is on its way (the one opening asks for).
  fetching: boolean;
  onPick: (branch: string) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  // A fresh search each time it opens.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const sorted = rankByScore(query, entries, (b) => b.name);

  return (
    <Combobox.Root
      value={branch}
      onValueChange={(v) => {
        const next = v as string | null;
        if (!next || next === branch) return;
        onPick(next);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      open={open}
      onOpenChange={onOpenChange}
      autoHighlight
    >
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
              {fetching && (
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
                  <SimpleTooltip whenTruncated lazy tip={entry.name}>
                    <span className="flex-1 truncate font-mono">
                      {entry.name}
                    </span>
                  </SimpleTooltip>
                  {entry.name === branch && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                  {entry.kind === "remote" && (
                    <span className="text-3xs text-muted-foreground">
                      remote
                    </span>
                  )}
                </Combobox.Item>
              ))}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
