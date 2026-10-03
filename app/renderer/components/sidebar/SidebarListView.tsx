// The forest's rows as a plain stacked list, for a picture of the
// sidebar (lab/scenes). The live list (SidebarList) virtualizes the
// same rows in the same wrappers (VirtualRow).
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ROW_LAYOUT, type SidebarRow } from "./sidebarRow";

// Stacked in order, each in the wrapper a virtual row wears (its slot
// and ROW_LAYOUT), so the rows sit where the live list puts them. A
// column of flex items, so a row's top margin (a shelf's) stays inside
// its wrapper as it does in the live list's absolutely placed ones.
// The virtualizer steps each row down by the whole-pixel height it
// measured the one above at, so a row of fractional height (the
// phone's) overhangs the next by the fraction. Each row sits in a box
// rounded the same way, where the browser can (calc-size), and keeps
// its own height inside it.
const ROW_STEP = { height: "calc-size(auto, round(size, 1px))" };

export function SidebarListView({
  rows,
  renderRow,
}: {
  rows: readonly SidebarRow[];
  renderRow: (row: SidebarRow) => ReactNode;
}) {
  return (
    <div className="relative flex flex-col">
      {rows.map((row, index) => (
        <div key={row.key} className="min-h-0" style={ROW_STEP}>
          <div
            data-index={index}
            data-slot="sidebar-row"
            className={cn("w-full", ROW_LAYOUT[row.kind])}
          >
            {renderRow(row)}
          </div>
        </div>
      ))}
    </div>
  );
}

// A row held still over the scroller (the open project's header), so
// it stays put as the rows scroll. It has no hover to track: the open
// project's title wears its actions at rest. The gap under it keeps
// the rows scrolling up from being cut off flush against the name.
export function PinnedRowView({
  kind,
  children,
}: {
  kind: SidebarRow["kind"];
  children: ReactNode;
}) {
  return (
    <div data-slot="sidebar-row" className={cn(ROW_LAYOUT[kind], "pb-1")}>
      {children}
    </div>
  );
}
