// The folders the list of projects gathers projects into, inside their
// owner (buildSidebarRows, folderRuns): a folder's header and its
// right-click, a project's pick of folder, and the dialog naming one.
import { ChevronDown } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "../../primitives/context-menu.tsx";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../primitives/dropdown-menu.tsx";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { cn } from "../../lib/utils.ts";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { FolderIconView } from "../shared/ProjectIconView.tsx";
import { CheckItemView } from "./SidebarToolbarView.tsx";

export function ProjectFolderHeaderView({
  dropRef,
  dropping = false,
  name,
  count,
  expanded,
  onToggle,
  onRename,
  onUngroup,
}: {
  // A drop target for a project dragged on the list, and whether one
  // over it would land.
  dropRef?: (node: HTMLElement | null) => void;
  dropping?: boolean;
  name: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onRename: () => void;
  // Takes every project out of it, back into their owner's list.
  onUngroup: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        {/* A row of the list like a project's, its projects set in
            under it, so it reads as one more thing in its owner. */}
        <button
          ref={dropRef}
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
            dropping && "bg-primary/15 text-foreground hover:bg-primary/15",
          )}
        >
          <FolderIconView name={name} />
          <SimpleTooltip whenTruncated tip={name}>
            <span className="min-w-0 flex-1 truncate">{name}</span>
          </SimpleTooltip>
          {!expanded && (
            <span className="text-3xs text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem onClick={onRename}>Rename…</DropdownMenuItem>
        <DropdownMenuItem onClick={onUngroup}>Ungroup</DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A project's menu's pick: no folder, one of the folders of its owner,
// or a new one.
export function ProjectFolderSubmenuView({
  folder,
  folders,
  onPick,
  onNewFolder,
}: {
  folder: string | null;
  folders: readonly string[];
  onPick: (folder: string | null) => void;
  onNewFolder: () => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Folder</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <CheckItemView checked={folder === null} onClick={() => onPick(null)}>
          None
        </CheckItemView>
        {folders.map((name) => (
          <CheckItemView
            key={name}
            checked={folder === name}
            onClick={() => onPick(name)}
          >
            {name}
          </CheckItemView>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onNewFolder}>New folder…</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// The dialog's content (FolderNameDialog puts it in a ModalShell).
export function FolderNameDialogView({
  title,
  verb,
  name,
  onNameChange,
  onSave,
  onCancel,
}: {
  title: string;
  verb: string;
  name: string;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="p-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h2 className="text-base font-semibold">{title}</h2>
      <Input
        className="mt-4 w-full"
        aria-label="Name"
        placeholder="Name"
        value={name}
        maxLength={64}
        onChange={(e) => onNameChange(e.target.value)}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to edit this field
        autoFocus
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" keys="↩" size="sm" disabled={name.trim() === ""}>
          {verb}
        </Button>
      </div>
    </form>
  );
}
