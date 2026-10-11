// A worktree row's right-click, in the tree and the inbox alike
// (WorktreeMenu binds it): the ways off it (its project, from the
// inbox, and its PR), its path and branch to copy, then what its page's
// footer holds (mirror, transplant, auto-pull, the shelf and delete).
// The list mounts only while the menu is open, so a row carries no more
// than the root.
import type { ReactElement, ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Copy,
  GitPullRequest,
  ListTree,
  RefreshCw,
  Shovel,
  Trash2,
} from "lucide-react";
import { useOutside } from "../../outside.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "../../primitives/context-menu.tsx";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../primitives/dropdown-menu.tsx";

export function WorktreeMenuView({
  row,
  onOpenChange,
  children,
}: {
  // An element for the trigger to `render`, so it wraps no extra div.
  row: ReactElement;
  onOpenChange: (open: boolean) => void;
  // The list (the views below), mounted while the menu is open.
  children: ReactNode;
}) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="min-w-48">{children}</ContextMenuContent>
    </ContextMenu>
  );
}

// The list's lead: the inbox's way to the project in the tree, the PR,
// and the path and branch to copy.
export function WorktreeMenuLeadView({
  onGoToProject,
  pullRequest,
  path,
  branch,
}: {
  onGoToProject?: () => void;
  pullRequest?: { number: number; url: string };
  path: string;
  // Absent for a detached worktree.
  branch?: string;
}) {
  const { openUrl } = useOutside();
  return (
    <>
      {onGoToProject && (
        <DropdownMenuItem onClick={onGoToProject}>
          <ListTree />
          Go to project
        </DropdownMenuItem>
      )}
      {pullRequest && (
        <DropdownMenuItem
          onClick={() => openUrl(pullRequest.url, "Couldn't open pull request")}
        >
          <GitPullRequest />
          Open pull request #{pullRequest.number}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={() => void navigator.clipboard.writeText(path)}
      >
        <Copy />
        Copy path
      </DropdownMenuItem>
      {branch !== undefined && (
        <DropdownMenuItem
          onClick={() => void navigator.clipboard.writeText(branch)}
        >
          <Copy />
          Copy branch name
        </DropdownMenuItem>
      )}
    </>
  );
}

// Mirror and transplant, when the page's footer would offer them, each
// opening the page with its dialog up. A worktree already mirrored
// offers its running mirror instead, as the footer's Mirroring button
// does.
export function WorktreeMenuTransfersView({
  onMirroring,
  mirror,
  onTransplant,
}: {
  onMirroring?: () => void;
  mirror?: { disabled: boolean; onClick: () => void };
  onTransplant?: () => void;
}) {
  if (!onMirroring && !mirror && !onTransplant) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {onMirroring && (
        <DropdownMenuItem onClick={onMirroring}>
          <RefreshCw />
          Mirroring…
        </DropdownMenuItem>
      )}
      {mirror && (
        <DropdownMenuItem disabled={mirror.disabled} onClick={mirror.onClick}>
          <RefreshCw />
          Mirror…
        </DropdownMenuItem>
      )}
      {onTransplant && (
        <DropdownMenuItem onClick={onTransplant}>
          <Shovel />
          Transplant…
        </DropdownMenuItem>
      )}
    </>
  );
}

// Auto-pull, the shelf and delete. Delete takes two clicks, the menu
// staying open while it is armed.
export function WorktreeMenuManageView({
  autoPull,
  shelve,
  remove,
}: {
  autoPull: {
    checked: boolean;
    disabled: boolean;
    onChange: (autoPull: boolean) => void;
  };
  // Only a managed worktree shelves.
  shelve?: { shelved: boolean; disabled: boolean; onToggle: () => void };
  // Never for the primary checkout, which is the project itself.
  remove?: { armed: boolean; disabled: boolean; onClick: () => void };
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={autoPull.checked}
        disabled={autoPull.disabled}
        onCheckedChange={autoPull.onChange}
      >
        <RefreshCw />
        Auto-pull
      </DropdownMenuCheckboxItem>
      {shelve && (
        <DropdownMenuItem disabled={shelve.disabled} onClick={shelve.onToggle}>
          {shelve.shelved ? <ArchiveRestore /> : <Archive />}
          {shelve.shelved ? "Unshelve" : "Shelve"}
        </DropdownMenuItem>
      )}
      {remove && (
        <DropdownMenuItem
          variant="destructive"
          disabled={remove.disabled}
          closeOnClick={remove.armed}
          onClick={(event) => {
            if (!remove.armed) event.preventDefault();
            remove.onClick();
          }}
        >
          <Trash2 />
          {remove.armed ? "Click again to delete" : "Delete worktree"}
        </DropdownMenuItem>
      )}
    </>
  );
}
