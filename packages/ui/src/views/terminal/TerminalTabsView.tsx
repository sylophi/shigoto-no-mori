// A row of terminal tabs over the picked one's body: each tab its
// label and a close, a new terminal at the row's end, and the drawer's
// hide after that. Left and right arrows move the pick, as tabs do. The
// row and the body are one surface, the card, inset to the page's
// gutter.
import type { ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { ChevronDown, Plus, X } from "lucide-react";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { useRevealPicked } from "../../hooks/useRevealPicked.ts";
import { cn } from "../../lib/utils.ts";

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
  note = null,
  children,
}: {
  tabs: readonly TerminalTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  // Absent where no terminal can be opened.
  onNew?: () => void;
  onHide: () => void;
  // What shows in place of the tabs' bodies while none can be shown (a
  // peer that takes no commands from here).
  note?: string | null;
  // The picked tab's body.
  children: ReactNode;
}) {
  const listRef = useRevealPicked(
    selectedId,
    tabs.map((tab) => tab.id),
  );
  return (
    <Tabs.Root
      value={selectedId}
      onValueChange={(id: string) => onSelect(id)}
      className="flex h-full min-h-0 flex-col bg-card"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-6 phone:px-4">
        <Tabs.List
          ref={listRef}
          activateOnFocus
          aria-label="Terminals"
          className="flex min-w-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const selected = tab.id === selectedId;
            return (
              // One pill built from two controls: the pill takes the
              // hover, and its close shows while it is hovered or picked.
              <div
                key={tab.id}
                data-slot="terminal-tab"
                className={cn(
                  "group flex h-6 shrink-0 items-center rounded-full pr-0.5 text-xs transition-colors",
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Tabs.Tab
                  value={tab.id}
                  data-slot="terminal-tab-pick"
                  aria-label={tab.label}
                  className={cn(
                    "flex h-full items-center pl-2.5",
                    tab.ended && "opacity-60",
                  )}
                >
                  <SimpleTooltip whenTruncated tip={tab.label}>
                    <span className="max-w-40 truncate">{tab.label}</span>
                  </SimpleTooltip>
                </Tabs.Tab>
                <IconButton
                  aria-label={`Close ${tab.label}`}
                  onClick={() => onClose(tab.id)}
                  reveal={!selected}
                  className="ml-0.5 rounded-full p-0.5 group-hover:opacity-100 hover:bg-foreground/10"
                >
                  <X className="size-3" />
                </IconButton>
              </div>
            );
          })}
        </Tabs.List>
        {onNew && (
          <IconButton
            aria-label="New terminal"
            onClick={onNew}
            className="rounded-full"
          >
            <Plus className="size-3.5" />
          </IconButton>
        )}
        <IconButton
          aria-label="Hide terminals"
          onClick={onHide}
          className="-mr-1 ml-auto rounded-full"
        >
          <ChevronDown className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        {note !== null ? (
          <CenteredMessage className="px-6 text-center">{note}</CenteredMessage>
        ) : (
          children
        )}
      </div>
    </Tabs.Root>
  );
}
