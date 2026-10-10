// A row of terminal tabs over the picked one's body: each tab its
// label and a close, a new terminal at the row's end, and whatever the
// place it sits in adds after that (a drawer's hide). Left and right arrows move the
// pick, as tabs do.
import type { ReactNode } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { useRovingPick } from "@shigomori/ui/hooks/useRovingPick.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";

export type TerminalTab = {
  readonly id: string;
  readonly label: string;
  // A shell that has exited, or a run that has ended.
  readonly ended?: boolean;
};

export function TerminalTabsView({
  tabs,
  selectedId,
  onSelect,
  onClose,
  onNew,
  onHide,
  children,
}: {
  tabs: readonly TerminalTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  // Absent where no terminal can be opened.
  onNew?: () => void;
  // Present where the tabs fold away (a drawer).
  onHide?: () => void;
  // The picked tab's body.
  children: ReactNode;
}) {
  const { listRef, onKeyDown } = useRovingPick({
    ids: tabs.map((tab) => tab.id),
    selectedId: selectedId ?? "",
    onSelect,
    pickedSelector: '[aria-selected="true"]',
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          ref={listRef}
          role="tablist"
          aria-label="Terminals"
          className="flex min-w-0 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const selected = tab.id === selectedId;
            return (
              <div
                key={tab.id}
                data-slot="terminal-tab"
                className={cn(
                  "group flex h-6 shrink-0 items-center rounded-md pr-0.5 text-xs transition-colors",
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-label={tab.label}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelect(tab.id)}
                  onKeyDown={onKeyDown}
                  className={cn(
                    "flex h-full items-center pl-2",
                    tab.ended && "opacity-60",
                  )}
                >
                  <SimpleTooltip whenTruncated tip={tab.label}>
                    <span className="max-w-40 truncate font-mono">
                      {tab.label}
                    </span>
                  </SimpleTooltip>
                </button>
                <IconButton
                  aria-label={`Close ${tab.label}`}
                  onClick={() => onClose(tab.id)}
                  className="ml-0.5 p-0.5"
                >
                  <X className="size-3" />
                </IconButton>
              </div>
            );
          })}
        </div>
        {onNew && (
          <IconButton aria-label="New terminal" onClick={onNew}>
            <Plus className="size-3.5" />
          </IconButton>
        )}
        {onHide && (
          <IconButton
            aria-label="Hide terminals"
            onClick={onHide}
            className="ml-auto"
          >
            <ChevronDown className="size-3.5" />
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
