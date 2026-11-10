// The parts the folder browsers (PathBrowserView) and the filter-first
// picker (PathPickerView) share: the list and the footer's key hints.
import { KEYS } from "../../lib/keys.ts";
import type { ReactNode } from "react";
import { Command } from "cmdk";
import { ArrowLeft, CornerLeftUp, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.ts";
import {
  EMPTY_CLASS,
  ITEM_CLASS,
  keepFocusInInput,
} from "../../primitives/cmdk-classes.ts";
import { KbdHint } from "../../primitives/kbd.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";

// The cmdk value's prefix on every row of the list, `..` included, so
// isBrowseRow tells "a row is highlighted" from "nothing is".
export const BROWSE_VALUE_PREFIX = "browse:";
export const BROWSE_UP = `${BROWSE_VALUE_PREFIX}up`;

export function browseValue(path: string): string {
  return `${BROWSE_VALUE_PREFIX}${path}`;
}

export function isBrowseRow(highlighted: string): boolean {
  return highlighted.startsWith(BROWSE_VALUE_PREFIX);
}

// A folder's rows in the caller's cmdk Command, whose input owns the
// keys: the `..` row, a row per entry, and what stands in for the
// entries while the folder loads, fails or is empty.
export function BrowseListView<E extends { name: string }>({
  entries,
  pathOf,
  highlighted,
  onUp,
  onOpen,
  renderIcon,
  label,
  dim,
  renderTrailing,
  loading,
  error,
  noMatch,
  emptyLabel = "Empty folder.",
  className,
}: {
  entries: readonly E[];
  pathOf: (entry: E) => string;
  highlighted: string;
  // The `..` row's move, while there is a folder above.
  onUp: (() => void) | undefined;
  // ↩ or a click on an entry's row.
  onOpen: (entry: E) => void;
  renderIcon: (entry: E, highlighted: boolean) => ReactNode;
  label?: (entry: E) => string;
  // Faded until it is highlighted.
  dim?: (entry: E) => boolean;
  renderTrailing?: (entry: E, path: string) => ReactNode;
  loading: boolean;
  error: boolean;
  // Why there are no entries, when a filter hid them all.
  noMatch: string | undefined;
  emptyLabel?: string;
  className?: string;
}) {
  return (
    <Command.List
      onMouseDown={keepFocusInInput}
      className={cn("overflow-y-auto", className)}
    >
      {onUp && (
        <Command.Item value={BROWSE_UP} onSelect={onUp} className={ITEM_CLASS}>
          <CornerLeftUp className="size-4 text-muted-foreground/80" />
          <span className="font-mono text-muted-foreground">..</span>
        </Command.Item>
      )}
      {loading ? (
        <div
          className={cn(EMPTY_CLASS, "flex items-center justify-center gap-2")}
        >
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <div className={EMPTY_CLASS}>Couldn&apos;t read folder.</div>
      ) : entries.length === 0 ? (
        <div className={EMPTY_CLASS}>{noMatch ?? emptyLabel}</div>
      ) : (
        entries.map((entry) => {
          const path = pathOf(entry);
          const value = browseValue(path);
          const name = label?.(entry) ?? entry.name;
          return (
            <Command.Item
              key={entry.name}
              value={value}
              onSelect={() => onOpen(entry)}
              className={cn(
                ITEM_CLASS,
                dim?.(entry) && "not-aria-selected:opacity-60",
              )}
            >
              {renderIcon(entry, value === highlighted)}
              <SimpleTooltip whenTruncated lazy tip={name}>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {name}
                </span>
              </SimpleTooltip>
              {renderTrailing?.(entry, path)}
            </Command.Item>
          );
        })
      )}
    </Command.List>
  );
}

// ↩ into the highlighted folder, and ← up out of this one. The arrows
// go without saying.
export function BrowseKeyHintsView({
  enterFolder,
  goUp,
}: {
  enterFolder: boolean;
  goUp: boolean;
}) {
  return (
    <>
      {enterFolder && <KbdHint keys={[KEYS.enter]} label="Enter folder" />}
      {goUp && <KbdHint keys={[<ArrowLeft key="left" />]} label="Go up" />}
    </>
  );
}
