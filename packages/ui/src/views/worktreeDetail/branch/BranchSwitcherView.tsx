import { noMatch } from "@shigomori/contracts/words";
import { useEffect, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { newBranchName } from "@shigomori/contracts/git/branches";
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
// or from the phone's branch menu (BranchActionsView), or onto a new one
// named by what is typed. BranchSwitcher lists the branches.
export function BranchSwitcherView({
  branch,
  entries,
  taken,
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
  // Every name a new branch can't take: the locals, the remotes (and
  // their local names) and the worktree's own.
  taken: ReadonlySet<string>;
  // A listing is on its way (the one opening asks for).
  fetching: boolean;
  // `create` for a new branch at the worktree's commit.
  onPick: (branch: string, create: boolean) => void;
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
  const newName = newBranchName(query);
  // Not before the list is in, which is what `taken` is checked against.
  const creatable =
    !fetching && newName !== null && !taken.has(newName) ? newName : null;

  return (
    <Combobox.Root
      value={branch}
      onValueChange={(v) => {
        const next = v as string | null;
        if (!next || next === branch) return;
        onPick(next, next === creatable);
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
        placeholder="Switch or create branch…"
        mono
        busy={fetching ? "Syncing branches" : undefined}
        anchor={anchorRef}
        sideOffset={6}
        className="w-72"
      >
        {sorted.length === 0 && !creatable && !fetching && (
          <ComboboxEmpty>{noMatch("branches")}</ComboboxEmpty>
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
        {creatable && (
          <ComboboxItem value={creatable}>
            <Plus aria-hidden className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Create</span>
            <span className="flex-1 truncate font-mono">{creatable}</span>
          </ComboboxItem>
        )}
      </ComboboxPopup>
    </Combobox.Root>
  );
}
