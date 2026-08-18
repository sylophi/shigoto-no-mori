// Shared chrome for cmdk-backed pickers (add-project browse + scan
// results, folder picker, command palette). Lifted to constants so the
// rows can't drift apart, and so doubutsu keeps a single hook: the
// highlight rides `[cmdk-item][aria-selected="true"]`, which the overlay
// already paints with the AC stripe animation.
export const ITEM_CLASS =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground";

// cmdk renders a group's heading as its own element, reachable only by
// its `[cmdk-group-heading]` attribute — hence the arbitrary variant.
export const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground first:[&_[cmdk-group-heading]]:pt-1";
