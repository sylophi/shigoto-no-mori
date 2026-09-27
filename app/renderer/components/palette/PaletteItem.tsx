import { createContext, use, type ReactNode } from "react";
import { Command } from "cmdk";
import { ITEM_CLASS, keepFocusInInput } from "@/components/ui/cmdk-classes";
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
  title,
  className,
  children,
}: {
  value: string;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  if (use(PaneKeys)) {
    return (
      <Command.Item
        value={value}
        onSelect={onSelect}
        disabled={disabled}
        title={title}
        className={cn(ITEM_CLASS, "aria-disabled:opacity-50", className)}
      >
        {children}
      </Command.Item>
    );
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={keepFocusInInput}
      onClick={onSelect}
      disabled={disabled}
      title={title}
      data-selected={selected || undefined}
      className={cn(RESTING_ITEM_CLASS, className)}
    >
      {children}
    </button>
  );
}

const HEADING_CLASS =
  "px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground";

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
