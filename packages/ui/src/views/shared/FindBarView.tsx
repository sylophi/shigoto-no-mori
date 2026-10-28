import type { Ref } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

// The find bar's switch, as a view that shows text takes it.
export interface FindToggle {
  readonly open: boolean;
  readonly keys: string;
  readonly onToggle: () => void;
}

// The open find bar, as a view that shows text takes it.
export interface FindBar {
  readonly inputRef: Ref<HTMLInputElement>;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly count: number;
  // The match shown, from 0.
  readonly current: number;
  readonly onStep: (by: 1 | -1) => void;
  readonly onClose: () => void;
}

// What opens the find bar, or closes it, beside a view's other
// controls: the find keys' other way in, and a phone's only one.
// Compact in the file viewer's slimmer bar.
export function FindButtonView({
  open,
  keys,
  onToggle,
  compact = false,
}: FindToggle & { compact?: boolean }) {
  return (
    <SimpleTooltip tip={keys}>
      <IconButton
        onClick={onToggle}
        aria-pressed={open}
        aria-label="Find"
        className={cn(compact && "shrink-0 p-0.5")}
      >
        <Search aria-hidden className={compact ? "size-3.5" : "size-4"} />
      </IconButton>
    </SimpleTooltip>
  );
}

// The find strip over a diff or a file: what to find, which match of
// how many is shown, and the way to the others. Enter steps forward,
// Shift+Enter back, and Escape closes it.
export function FindBarView({
  inputRef,
  query,
  onQuery,
  count,
  current,
  onStep,
  onClose,
}: FindBar) {
  return (
    <div
      data-slot="search-row"
      className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5"
    >
      <Search
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find"
        aria-label="Find"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
      />
      {query && (
        <span
          aria-live="polite"
          className="tabular shrink-0 text-2xs text-muted-foreground"
        >
          {count === 0 ? "No matches" : `${current + 1} of ${count}`}
        </span>
      )}
      <IconButton
        size="xs"
        onClick={() => onStep(-1)}
        disabled={count === 0}
        aria-label="Previous match"
      >
        <ChevronUp aria-hidden className="size-3.5" />
      </IconButton>
      <IconButton
        size="xs"
        onClick={() => onStep(1)}
        disabled={count === 0}
        aria-label="Next match"
      >
        <ChevronDown aria-hidden className="size-3.5" />
      </IconButton>
      <IconButton size="xs" onClick={onClose} aria-label="Close find">
        <X aria-hidden className="size-3.5" />
      </IconButton>
    </div>
  );
}
