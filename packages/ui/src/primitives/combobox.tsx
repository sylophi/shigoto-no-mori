import type { ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Loader2, Search } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { useThemeRoot } from "../root.tsx";
import type { WithoutTitle } from "./tooltip.tsx";

// The popup a searchable Base UI combobox opens: a search row over its
// list, mounted in the theme root. The view keeps its own trigger and
// rows (ComboboxItem, ComboboxEmpty), and sets the width.
function ComboboxPopup({
  placeholder,
  mono = false,
  busy,
  anchor,
  sideOffset = 4,
  align = "start",
  className,
  children,
}: {
  placeholder: string;
  // What is typed is a name in code (a branch), and reads in mono.
  mono?: boolean;
  // Names what the list waits on, with a spinner, while it waits.
  busy?: string;
  anchor?: Combobox.Positioner.Props["anchor"];
  sideOffset?: number;
  align?: Combobox.Positioner.Props["align"];
  className?: string;
  children: ReactNode;
}) {
  return (
    <Combobox.Portal container={useThemeRoot()}>
      <Combobox.Positioner
        anchor={anchor}
        sideOffset={sideOffset}
        side="bottom"
        align={align}
        className="z-50"
      >
        <Combobox.Popup
          data-slot="combobox-popup"
          className={cn(
            "flex max-h-72 flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md",
            className,
          )}
        >
          <div
            data-slot="search-row"
            className="flex items-center gap-2 border-b border-border px-3"
          >
            <Search
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground/60"
            />
            <Combobox.Input
              placeholder={placeholder}
              className={cn(
                "flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground",
                mono && "font-mono placeholder:font-sans",
              )}
            />
            {busy && (
              <Loader2
                aria-label={busy}
                className="size-3.5 shrink-0 animate-spin text-muted-foreground/60"
              />
            )}
          </div>
          <Combobox.List className="flex-1 overflow-y-auto p-1">
            {children}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}

function ComboboxItem(
  props: WithoutTitle<Omit<Combobox.Item.Props, "className">>,
) {
  return (
    <Combobox.Item
      className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
      {...props}
    />
  );
}

// The list's line when no row shows.
function ComboboxEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-3 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export { ComboboxPopup, ComboboxItem, ComboboxEmpty };
