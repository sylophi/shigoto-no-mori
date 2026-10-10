import type { KeyboardEvent, ReactNode } from "react";
import { Command, useCommandState } from "cmdk";
import { ArrowDown, ArrowUp } from "lucide-react";
import { KbdHint } from "../../primitives/kbd.tsx";
import {
  EMPTY_CLASS,
  INPUT_CLASS,
  keepFocusInInput,
  MODAL_COMMAND_CLASS,
} from "../../primitives/cmdk-classes.ts";
import { BranchLabel } from "../../primitives/branch-label.tsx";
import { DeviceBadgeView } from "../sidebar/DeviceBadgeView.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { PaneKeysProvider } from "./PaletteItemView.tsx";
import type { PaletteRow } from "./paletteEntries.ts";
import { FooterRow } from "../../primitives/footer-row.tsx";

// The ⌘K palette's content, inside its dialog (WorktreePalette.tsx
// runs it): the search row, the list beside the highlighted row's
// verbs, and the keys that move between them.
export function PaletteDialogView({
  picked,
  highlighted,
  onHighlight,
  chip,
  query,
  onQueryChange,
  onInputKeyDown,
  list,
  emptyList,
  verbs,
  current,
}: {
  // The verbs hold the keys, not the list.
  picked: boolean;
  highlighted: string;
  onHighlight: (value: string) => void;
  // The row whose verbs have the keys (PickedChipView).
  chip: ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  onInputKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  // The list's rows, grouped under headings when of more than one kind.
  list: ReactNode;
  // What the list says when nothing matches.
  emptyList: string;
  // The highlighted row's verbs (PaletteVerbs).
  verbs: ReactNode;
  // The highlighted row's kind, for what ↩ does.
  current: PaletteRow["kind"] | undefined;
}) {
  // Keyed by stage: the pane holding the keys changes, and a fresh
  // mount keeps the highlight it is handed.
  return (
    <Command
      key={picked ? "verbs" : "list"}
      label="Worktrees"
      loop
      shouldFilter={false}
      value={highlighted}
      onValueChange={onHighlight}
      className={cn(MODAL_COMMAND_CLASS, "flex-1")}
    >
      <div
        data-slot="search-row"
        className="flex items-center gap-2 border-b border-border px-3 py-2"
      >
        {chip}
        {picked ? (
          <Command.Input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the verbs just took the keys
            autoFocus
            value={query}
            onValueChange={onQueryChange}
            onKeyDown={onInputKeyDown}
            placeholder="Search actions…"
            className={INPUT_CLASS}
          />
        ) : (
          <ListInput
            value={query}
            onValueChange={onQueryChange}
            onKeyDown={onInputKeyDown}
          />
        )}
      </div>

      {/* The panes scroll, not the list: cmdk's sizer (the list's one
          child) is the row that holds them, filling what's left. */}
      <Command.List
        onMouseDown={keepFocusInInput}
        className="flex min-h-0 flex-1 flex-col [&>[cmdk-list-sizer]]:flex [&>[cmdk-list-sizer]]:min-h-0 [&>[cmdk-list-sizer]]:flex-1"
      >
        <div
          className={cn(
            "min-w-0 flex-1 overflow-y-auto p-2",
            picked && "opacity-60 phone:hidden",
          )}
        >
          <PaneKeysProvider value={!picked}>{list}</PaneKeysProvider>
          {!picked && (
            <Command.Empty className={EMPTY_CLASS}>{emptyList}</Command.Empty>
          )}
        </div>
        <div
          data-slot="palette-verbs"
          className={cn(
            "w-64 shrink-0 overflow-y-auto border-l border-border bg-muted/30 p-2 phone:w-auto phone:flex-1 phone:border-l-0",
            !picked && "phone:hidden",
          )}
        >
          <PaneKeysProvider value={picked}>{verbs}</PaneKeysProvider>
          {picked && (
            <Command.Empty className={EMPTY_CLASS}>
              No actions match.
            </Command.Empty>
          )}
        </div>
      </Command.List>

      <FooterRow>
        <KbdHint
          keys={[<ArrowUp key="up" />, <ArrowDown key="down" />]}
          label="Navigate"
        />
        <KbdHint
          keys={["↩"]}
          label={picked ? "Run" : current === "create" ? "Create" : "Open"}
        />
        {picked ? (
          <KbdHint keys={["⌫"]} label="Back" />
        ) : (
          <>
            {current === "worktree" && (
              <KbdHint keys={["⌘↩"]} label="Changes" />
            )}
            <KbdHint keys={["⇥"]} label="Actions" />
          </>
        )}
      </FooterRow>
    </Command>
  );
}

// The list's input. Not cmdk's own: cmdk moves the highlight to the
// first row on every change of its query, including the one that puts
// the list's query back after the verbs, which would lose the row they
// were for. The dialog picks the top match itself as the query changes.
function ListInput({
  value,
  onValueChange,
  onKeyDown,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const activeId = useCommandState((state) => state.selectedItemId);
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette just opened
      autoFocus
      type="text"
      aria-activedescendant={activeId}
      aria-label="Search worktrees"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Search worktrees, projects, devices, PRs…"
      className={INPUT_CLASS}
    />
  );
}

// The row whose verbs have the keys, ahead of their query. A click (or
// ⌫) goes back to the list.
export function PickedChipView({
  row,
  icon,
  onBack,
}: {
  row: PaletteRow;
  // A worktree's project icon (ProjectIcon).
  icon: ReactNode;
  onBack: () => void;
}) {
  return (
    <SimpleTooltip tip="Back (⌫)">
      <button
        type="button"
        onClick={onBack}
        onMouseDown={keepFocusInInput}
        className="flex max-w-[50%] shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs"
      >
        <PickedLabel row={row} icon={icon} />
      </button>
    </SimpleTooltip>
  );
}

function PickedLabel({ row, icon }: { row: PaletteRow; icon: ReactNode }) {
  switch (row.kind) {
    case "worktree": {
      const { worktree, device } = row.entry;
      return (
        <>
          {icon}
          <span className="truncate font-mono">
            <BranchLabel
              branch={worktree.branch}
              detached={worktree.detached}
            />
          </span>
          {device && <DeviceBadgeView badge={device} />}
        </>
      );
    }
    case "project":
      return <span className="truncate">{row.item.project.name}</span>;
    case "page":
      return <span className="truncate">{row.page.label}</span>;
    case "create":
      return <span className="truncate font-mono">{row.branch}</span>;
  }
}
