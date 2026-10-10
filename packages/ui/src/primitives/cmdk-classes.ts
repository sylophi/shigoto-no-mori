import type { MouseEvent } from "react";

// Every selectable cmdk row (add-project entries, the folder picker)
// shares one look; lifted to a constant so they can't drift.
export const ITEM_CLASS =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground";

// A cmdk list's search input, its empty state, and a heading over a
// run of its rows.
export const INPUT_CLASS =
  "min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground";
export const EMPTY_CLASS = "p-3 text-center text-xs text-muted-foreground";
export const HEADING_CLASS =
  "px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground";

// For a Command that is a modal's body (primitives/modal-shell.tsx): a column
// that shrinks to the window, so its list scrolls instead of clipping.
export const MODAL_COMMAND_CLASS = "flex min-h-0 flex-col";

// For the Command.List of a flow whose keys are all handled on its
// input (the add-project browser, the folder picker): a click on a row
// must not take focus off that input, or the next ↩ lands on the list
// and selects its highlighted row instead.
export const keepFocusInInput = (e: MouseEvent) => e.preventDefault();
