// The inbox's New worktree button and its list of projects to create
// in (NewWorktreeButton binds them).
import type {
  ComponentProps,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
} from "react";
import { Command } from "cmdk";
import { Loader2, Plus, Search } from "lucide-react";
import { Button } from "../../../primitives/button.tsx";
import {
  EMPTY_CLASS,
  HEADING_CLASS,
  INPUT_CLASS,
  ITEM_CLASS,
  MODAL_COMMAND_CLASS,
} from "../../../primitives/cmdk-classes.ts";
import { KbdHint } from "../../../primitives/kbd.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../primitives/popover.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import { cn } from "../../../lib/utils.ts";
import type { ProjectListRow, ProjectSection } from "../sidebarRow.ts";
import { FooterRow } from "../../../primitives/footer-row.tsx";

// The button itself: creating outright, or the list's trigger.
export function NewWorktreeButtonView({
  pending = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  // A create under way.
  pending?: boolean;
}) {
  return (
    <Button variant="outline" size="sm" className="w-full" {...props}>
      {pending ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : (
        <Plus aria-hidden />
      )}
      {pending ? "Creating worktree…" : "New worktree"}
    </Button>
  );
}

// The button opening the list (CreateMenuListView), hung under it.
export function CreateMenuView({
  open,
  onOpenChange,
  inputRef,
  list,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The search, focused as the list opens from a pointer (a tap would
  // bring up a phone's keyboard over the list).
  inputRef: RefObject<HTMLInputElement | null>;
  list: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<NewWorktreeButtonView />} />
      <PopoverContent
        initialFocus={(openType) =>
          openType === "touch" ? false : inputRef.current
        }
        sideOffset={6}
        className="flex w-(--anchor-width) flex-col overflow-hidden p-0"
      >
        {list}
      </PopoverContent>
    </Popover>
  );
}

// The projects to create in, searchable, under their owners. A search
// is one list, best match first.
export function CreateMenuListView({
  query,
  onQueryChange,
  inputRef,
  sections,
  onModifier,
  renderRow,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  sections: readonly ProjectSection[];
  // Notes whether the ↩ or click that picks a row held a modifier.
  onModifier?: (event: KeyboardEvent | MouseEvent) => void;
  // A project's row (CreateTargetItemView), under its creator's scope.
  renderRow: (target: ProjectListRow) => ReactNode;
}) {
  return (
    <Command
      label="New worktree in"
      loop
      shouldFilter={false}
      onKeyDownCapture={onModifier}
      onClickCapture={onModifier}
      className={MODAL_COMMAND_CLASS}
    >
      <div
        data-slot="search-row"
        className="flex items-center gap-2 border-b border-border px-3 py-1.5"
      >
        <Search
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <Command.Input
          ref={inputRef}
          value={query}
          onValueChange={onQueryChange}
          placeholder="New worktree in…"
          className={INPUT_CLASS}
        />
      </div>
      <Command.List className="max-h-80 min-h-0 overflow-y-auto p-1">
        {sections.map((section) => (
          <Command.Group
            key={section.key}
            heading={
              section.label === null ? undefined : (
                <div className={cn(HEADING_CLASS, "truncate")}>
                  {section.label}
                </div>
              )
            }
          >
            {section.rows.map((target) => renderRow(target))}
          </Command.Group>
        ))}
        <Command.Empty className={EMPTY_CLASS}>
          No projects match.
        </Command.Empty>
      </Command.List>
      <FooterRow className="px-3 py-2 text-2xs phone:hidden">
        {/* ↩ creating goes without saying. ⇧ is for a click too. */}
        <KbdHint keys={["⇧"]} label="Pick a base" />
      </FooterRow>
    </Command>
  );
}

// A project in the list: its icon (a spinner while its create is under
// way), its name, and the device it lands on when that's a peer.
export function CreateTargetItemView({
  value,
  name,
  busy,
  disabled,
  onSelect,
  icon,
  badge,
}: {
  value: string;
  name: string;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
  // The project's icon (ProjectIcon), and the peer's badge
  // (DeviceBadgeView).
  icon: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      disabled={disabled}
      className={ITEM_CLASS}
    >
      {busy ? (
        <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
      ) : (
        icon
      )}
      <SimpleTooltip whenTruncated tip={name}>
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </SimpleTooltip>
      {badge}
    </Command.Item>
  );
}
