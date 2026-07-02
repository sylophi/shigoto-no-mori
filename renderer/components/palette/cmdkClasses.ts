// cmdk's group heading is a child of Command.Group, so the only way to
// style it is by selecting through the parent's className. Lifted to a
// constant so every group in the palette renders an identical heading.
export const GROUP_HEADING_CLASS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase";

// Every selectable row in the palette (browse entries, scan results,
// navigation actions) shares one look; lifted for the same reason as
// the heading above.
export const ITEM_CLASS =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground";
