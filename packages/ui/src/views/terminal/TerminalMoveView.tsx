// The picked terminal's move to another worktree: a button in the tab
// row that opens a search of the worktrees it can go to.
import { noMatch } from "@shigomori/contracts/words";
import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { FolderInput } from "lucide-react";
import { rankByScore } from "../../lib/fuzzyMatch.ts";
import {
  ComboboxEmpty,
  ComboboxItem,
  ComboboxPopup,
} from "../../primitives/combobox.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";

// A worktree the terminal can move to: what its work is called, and its
// folder's name.
export type MoveTarget = {
  readonly id: string;
  readonly label: string;
  readonly name: string;
};

export function TerminalMoveView({
  targets,
  onMove,
}: {
  targets: readonly MoveTarget[];
  onMove: (worktreeId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = rankByScore(query, targets, (target) => [
    target.label,
    target.name,
  ]);
  return (
    <Combobox.Root
      value={null}
      onValueChange={(id) => {
        if (typeof id === "string") onMove(id);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (open) setQuery("");
      }}
      autoHighlight
    >
      <SimpleTooltip tip="Move to another worktree">
        <Combobox.Trigger
          aria-label="Move to another worktree"
          render={<IconButton className="rounded-full" />}
        >
          <FolderInput className="size-3.5" />
        </Combobox.Trigger>
      </SimpleTooltip>
      <ComboboxPopup
        placeholder="Move to worktree…"
        align="end"
        className="w-96 max-w-[calc(100vw-2rem)]"
      >
        {shown.map((target) => (
          <ComboboxItem key={target.id} value={target.id}>
            <span className="min-w-0 flex-1 truncate">{target.label}</span>
            {target.name !== target.label && (
              <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                {target.name}
              </span>
            )}
          </ComboboxItem>
        ))}
        {shown.length === 0 && (
          <ComboboxEmpty>{noMatch("worktrees")}</ComboboxEmpty>
        )}
      </ComboboxPopup>
    </Combobox.Root>
  );
}
