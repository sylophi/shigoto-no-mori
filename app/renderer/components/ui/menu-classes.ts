// The menus' look, shared by the live menus (dropdown-menu.tsx) and the
// static one a scene draws open (menu-view.tsx), so the two can't drift.
import { cn } from "@/lib/utils";
import { FLOATING_SURFACE_CLASS } from "./floating-surface";

export const MENU_SURFACE_CLASS = cn(
  FLOATING_SURFACE_CLASS,
  "min-w-40 overflow-x-hidden",
);

export const MENU_LABEL_CLASS =
  "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7";

export const MENU_ITEM_CLASS =
  "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-6 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:cursor-not-allowed data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-[variant=destructive]:*:[svg]:text-destructive";
