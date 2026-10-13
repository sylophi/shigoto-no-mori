import { Fragment, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, FilePen, Loader2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "../../primitives/context-menu.tsx";
import { DropdownMenuItem } from "../../primitives/dropdown-menu.tsx";
import { MaterialIcon } from "../../primitives/material-icon.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { parentOf } from "./treePaths.ts";

// The files page's list: the worktree as a folder tree (FileTree.tsx
// reads it a folder at a time). Rows are one flat run of buttons in
// document order, whatever their depth, which is what keeps the arrow
// keys a sibling query away. Where files open in the editor, a file's
// right click opens one menu the whole tree shares, anchored at the
// pointer, like the diff's file list.
export function FileTreeView({
  expanded,
  onToggleFolder,
  onOpenFile,
  className,
  children,
}: {
  expanded: ReadonlySet<string>;
  onToggleFolder: (path: string, open: boolean) => void;
  // Opens a file in the editor. Absent where the files aren't this
  // machine's.
  onOpenFile?: (path: string) => void;
  // The box is the caller's: the app sidebar's slot on a wide viewport,
  // the page itself or its sheet on a phone.
  className?: string;
  // The top folder's rows, given the file whose menu is up (its row
  // stays lit while it is).
  children: (menuPath: string | null) => ReactNode;
}) {
  // The file whose menu is up. The path outlives `open` so the menu
  // keeps its items while it closes.
  const [menu, setMenu] = useState<{ path: string; open: boolean } | null>(
    null,
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [
      ...e.currentTarget.querySelectorAll<HTMLElement>("[data-tree-path]"),
    ];
    if (rows.length === 0) return;
    const active = e.currentTarget.ownerDocument.activeElement;
    const at = rows.findIndex((row) => row === active);
    const row = rows[at];
    const focus = (i: number) => {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return focus(at + 1);
      case "ArrowUp":
        return focus(at - 1);
      case "Home":
        return focus(0);
      case "End":
        return focus(rows.length - 1);
      case "ArrowRight": {
        if (!row || row.dataset["treeFolder"] === undefined) return;
        const path = row.dataset["treePath"] ?? "";
        if (expanded.has(path)) return focus(at + 1);
        e.preventDefault();
        return onToggleFolder(path, true);
      }
      case "ArrowLeft": {
        if (!row) return;
        const path = row.dataset["treePath"] ?? "";
        if (row.dataset["treeFolder"] !== undefined && expanded.has(path)) {
          e.preventDefault();
          return onToggleFolder(path, false);
        }
        const parent = parentOf(path);
        if (parent === "") return;
        return focus(rows.findIndex((r) => r.dataset["treePath"] === parent));
      }
    }
  };

  return (
    <ContextMenu
      disabled={!onOpenFile}
      open={menu?.open ?? false}
      onOpenChange={(open, details) => {
        if (!open) {
          setMenu((current) => current && { ...current, open: false });
          return;
        }
        // Files have a menu. Folders and the empty space don't.
        const target = details.event.target;
        const file =
          target instanceof Element
            ? target.closest("[data-tree-path]:not([data-tree-folder])")
            : null;
        const path = file?.getAttribute("data-tree-path");
        if (path) setMenu({ path, open: true });
      }}
    >
      <ContextMenuTrigger
        render={
          <div
            data-slot="file-tree"
            role="tree"
            aria-label="Files"
            // The rows take the tab stop (see tabIndex on the row).
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className={cn("flex flex-col overflow-y-auto p-1", className)}
          />
        }
      >
        {children(menu?.open ? menu.path : null)}
      </ContextMenuTrigger>
      {menu && onOpenFile && (
        <ContextMenuContent>
          <DropdownMenuItem onClick={() => onOpenFile(menu.path)}>
            <FilePen />
            Open in editor
          </DropdownMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

// One folder's entries, each open folder's own under it.
export function FileTreeRowsView({
  parent,
  entries,
  depth,
  selectedPath,
  expanded,
  tabStop,
  menuPath,
  onToggleFolder,
  onSelectFile,
  onOpenFile,
  renderFolder,
}: {
  // The folder they are in, "" for the top.
  parent: string;
  entries: readonly { name: string; isDirectory: boolean; ignored: boolean }[];
  depth: number;
  selectedPath: string | null;
  expanded: ReadonlySet<string>;
  // The row holding the tree's one tab stop, or null for the first.
  tabStop: string | null;
  // The file whose menu is up.
  menuPath?: string | null;
  onToggleFolder: (path: string, open: boolean) => void;
  onSelectFile: (path: string) => void;
  // Opens a file in the editor, on a double click.
  onOpenFile?: (path: string) => void;
  // An open folder's rows.
  renderFolder: (path: string) => ReactNode;
}) {
  return entries.map((entry, index) => {
    const path = parent ? `${parent}/${entry.name}` : entry.name;

    const open = entry.isDirectory && expanded.has(path);
    const selected = path === selectedPath;
    return (
      <Fragment key={path}>
        <button
          type="button"
          role="treeitem"
          data-slot="file-tree-row"
          data-tree-path={path}
          data-tree-folder={entry.isDirectory ? "" : undefined}
          aria-level={depth + 1}
          aria-expanded={entry.isDirectory ? open : undefined}
          aria-selected={entry.isDirectory ? undefined : selected}
          // One stop in the tab order (see tabStop). The arrow keys walk
          // the rest.
          tabIndex={
            path === tabStop || (tabStop === null && depth === 0 && index === 0)
              ? 0
              : -1
          }
          ref={selected ? revealRow : undefined}
          onClick={() =>
            entry.isDirectory ? onToggleFolder(path, !open) : onSelectFile(path)
          }
          onDoubleClick={
            entry.isDirectory || !onOpenFile
              ? undefined
              : () => onOpenFile(path)
          }
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          className={cn(
            "flex w-full shrink-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors",
            selected
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50 hover:text-foreground",
            path === menuPath && !selected && "bg-accent/50",
            entry.ignored && !selected && "opacity-55",
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              !entry.isDirectory && "invisible",
              open && "rotate-90",
            )}
          />
          <MaterialIcon
            kind={entry.isDirectory ? "folder" : "file"}
            name={entry.name}
            expanded={open}
            className="size-4"
          />
          <SimpleTooltip whenTruncated lazy tip={entry.name}>
            <span className="min-w-0 flex-1 truncate font-mono text-2xs">
              {entry.name}
            </span>
          </SimpleTooltip>
        </button>
        {open && renderFolder(path)}
      </Fragment>
    );
  });
}

// Brings the open file's row on screen when it becomes the open one (a
// linked file deep in the tree, once its folders have loaded). Module
// level, so an unchanged selection doesn't call it again every render.
// `nearest` leaves a row that is already on screen where it is.
const revealRow = (row: HTMLButtonElement | null) =>
  row?.scrollIntoView({ block: "nearest" });

// A folder's stand-in row while it loads, when it is empty, or when it
// couldn't be read, at the depth its entries would sit.
export function FileTreeNoteView({
  depth,
  loading = false,
  children,
}: {
  depth: number;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="none"
      style={{ paddingLeft: `${depth * 12 + 22}px` }}
      className="flex shrink-0 items-center gap-1.5 py-1 text-2xs text-muted-foreground"
    >
      {loading && <Loader2 aria-hidden className="size-3 animate-spin" />}
      {children}
    </div>
  );
}
