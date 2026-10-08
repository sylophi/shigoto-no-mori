import { createContext, use, type ReactNode } from "react";
import { Command } from "cmdk";
import {
  HEADING_CLASS,
  ITEM_CLASS,
  keepFocusInInput,
} from "@/components/ui/cmdk-classes";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Whether the pane an item sits in holds the keys. The palette has two
// panes, the rows and the highlighted row's verbs, and ↑↓ and ↩ move
// through one of them at a time: ⇥ hands them to the verbs, ⌫ back.
const PaneKeys = createContext(false);
export const PaneKeysProvider = PaneKeys.Provider;
export const usePaneHasKeys = () => use(PaneKeys);

// The same row cmdk draws, for the pane without the keys: a plain
// button, so a click still works but ↑↓ never wander into it.
const RESTING_ITEM_CLASS = cn(
  ITEM_CLASS,
  "w-full text-left hover:bg-accent/60 disabled:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
);

// One row in either pane: a cmdk item in the pane holding the keys, a
// resting button in the other. `selected` marks the resting pane's row
// the other pane is about (the worktree whose verbs are showing).
export function PaletteItem({
  value,
  onSelect,
  disabled,
  selected,
  tip,
  className,
  children,
}: {
  value: string;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;
  tip?: string;
  className?: string;
  children: ReactNode;
}) {
  const item = use(PaneKeys) ? (
    <Command.Item
      value={value}
      onSelect={onSelect}
      disabled={disabled}
      className={cn(ITEM_CLASS, "aria-disabled:opacity-50", className)}
    >
      {children}
    </Command.Item>
  ) : (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={keepFocusInInput}
      onClick={onSelect}
      disabled={disabled}
      data-selected={selected || undefined}
      className={cn(RESTING_ITEM_CLASS, className)}
    >
      {children}
    </button>
  );
  // Most rows (every worktree) never have a tip, and the palette holds
  // a lot of them: a tooltip only where a row can have one.
  if (tip === undefined) return item;
  return <SimpleTooltip tip={tip}>{item}</SimpleTooltip>;
}

// A heading over a run of items, in cmdk's group when the pane holds
// the keys (so its filtering hides an empty one) and the same look
// when it doesn't.
export function PaletteGroup({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  const title = <div className={HEADING_CLASS}>{heading}</div>;
  if (use(PaneKeys)) {
    return <Command.Group heading={title}>{children}</Command.Group>;
  }
  return (
    <div role="presentation">
      {title}
      {children}
    </div>
  );
}
