import { useEffect, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown } from "lucide-react";
import { type BranchEntry } from "../../shared/BranchComboboxView.tsx";
import { rankByScore } from "../../../lib/fuzzyMatch.ts";
import { IconButton } from "../../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import {
  ComboboxEmpty,
  ComboboxItem,
  ComboboxPopup,
} from "../../../primitives/combobox.tsx";

// Switching the worktree's branch, from its own button beside the name
// or from the phone's branch menu (BranchActionsView). BranchSwitcher
// lists the branches.
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
      <Combobox.Trigger
        render={
          <IconButton
            aria-label="Switch branch"
            reveal
            // Beside the branch, which shows it on hover (BranchTitleView).
            className="group-hover/copy:opacity-100 data-[popup-open]:bg-accent data-[popup-open]:text-foreground data-[popup-open]:opacity-100"
          />
        }
      >
        <ChevronsUpDown aria-hidden className="size-3.5" />
      </Combobox.Trigger>
      <ComboboxPopup
        placeholder="Switch to branch…"
        mono
        busy={fetching ? "Syncing branches" : undefined}
        anchor={anchorRef}
        sideOffset={6}
        className="w-72"
      >
        {sorted.length === 0 && (
          <ComboboxEmpty>No matching branches.</ComboboxEmpty>
        )}
        {sorted.map((entry) => (
          <ComboboxItem key={`${entry.kind}:${entry.name}`} value={entry.name}>
            <SimpleTooltip whenTruncated lazy tip={entry.name}>
              <span className="flex-1 truncate font-mono">{entry.name}</span>
            </SimpleTooltip>
            {entry.name === branch && (
              <Check className="size-3.5 text-muted-foreground" />
            )}
            {entry.kind === "remote" && (
              <span className="text-3xs text-muted-foreground">remote</span>
            )}
          </ComboboxItem>
        ))}
      </ComboboxPopup>
    </Combobox.Root>
  );
}
