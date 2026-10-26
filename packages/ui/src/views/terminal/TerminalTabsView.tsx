// A row of terminal tabs over the picked one's body: each tab its
// label and a close, a new terminal at the row's end, and the drawer's
// pop-out, dock switch and hide after that. Left and right arrows move
// the pick, as tabs do. The row and the body are one surface, the card. The
// picked tab's body may put a control of its own at the row's end
// (TerminalTabToolbar).
import { createContext, use, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Tabs } from "@base-ui/react/tabs";
import {
  ChevronDown,
  ChevronRight,
  PanelBottom,
  PanelRight,
  Plus,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { useRevealPicked } from "../../hooks/useRevealPicked.ts";
import { cn, dragRegion } from "../../lib/utils.ts";

const ToolbarSlot = createContext<HTMLElement | null>(null);

// Controls the picked tab's body shows in the tab row, before the hide.
// A portal, since their state is the body's (a script console's run),
// and the body is rendered inside the tabs rather than around them.
export function TerminalTabToolbar({ children }: { children: ReactNode }) {
  const slot = use(ToolbarSlot);
  return slot === null ? null : createPortal(children, slot);
}

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
  side = false,
  onDock,
  onPopOut,
  onHide,
  titleBar = false,
  note = null,
  children,
}: {
  tabs: readonly TerminalTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  // Absent where no terminal can be opened.
  onNew?: () => void;
  // Docked at the side rather than the bottom, and the switch to the
  // other.
  side?: boolean;
  onDock?: () => void;
  // Moves the tabs to a window of their own. Desktop only.
  onPopOut?: () => void;
  onHide?: () => void;
  // The row is a window's title bar, on the traffic lights' line.
  titleBar?: boolean;
  // What shows in place of the tabs' bodies while none can be shown (a
  // peer that takes no commands from here).
  note?: string | null;
  // The picked tab's body.
  children: ReactNode;
}) {
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const buttons = [onPopOut, onDock, onHide].filter(Boolean).length;
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
      {/* Its controls are clear of the window's title-bar drag strip,
          which the row sits under when docked at the side. As a title
          bar it clears the traffic lights and centers on them (y=23,
          main/electron/windows.ts), and drags the window. */}
      <div
        className={cn(
          "relative flex shrink-0 flex-wrap items-center gap-x-2",
          titleBar ? "pt-[7px] pl-[92px]" : "pl-3",
          ["pr-3", "pr-9", "pr-16", "pr-23"][buttons],
          onHide ? "phone:pr-9" : "phone:pr-3",
        )}
        style={titleBar ? dragRegion("drag") : undefined}
      >
        <div
          className="flex h-8 min-w-0 items-center gap-1"
          style={dragRegion("no-drag")}
        >
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
              className="shrink-0 rounded-full"
            >
              <Plus className="size-3.5" />
            </IconButton>
          )}
        </div>
        {/* Its controls carve their clicks out of a title bar, and the
            room between them still drags the window. */}
        <div
          ref={setToolbar}
          className="flex h-8 flex-auto items-center justify-end gap-2 *:[app-region:no-drag] empty:hidden"
        />
        {/* Out of the flow, so it stays on the first line when the
            controls wrap. */}
        <div
          className={cn(
            "absolute right-2 flex h-8 items-center gap-1",
            titleBar ? "top-[7px]" : "top-0",
          )}
          style={dragRegion("no-drag")}
        >
          {onPopOut && (
            <IconButton
              aria-label="Open in new window"
              onClick={onPopOut}
              className="rounded-full phone:hidden"
            >
              <SquareArrowOutUpRight className="size-3.5" />
            </IconButton>
          )}
          {onDock && (
            <IconButton
              aria-label={side ? "Dock to the bottom" : "Dock to the side"}
              onClick={onDock}
              className="rounded-full phone:hidden"
            >
              {side ? (
                <PanelBottom className="size-3.5" />
              ) : (
                <PanelRight className="size-3.5" />
              )}
            </IconButton>
          )}
          {onHide && (
            <IconButton
              aria-label="Hide terminals"
              onClick={onHide}
              className="rounded-full"
            >
              {side ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </IconButton>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {note !== null ? (
          <CenteredMessage className="px-3 text-center">{note}</CenteredMessage>
        ) : (
          <ToolbarSlot value={toolbar}>{children}</ToolbarSlot>
        )}
      </div>
    </Tabs.Root>
  );
}
