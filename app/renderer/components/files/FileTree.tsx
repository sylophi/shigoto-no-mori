import { Fragment, type KeyboardEvent } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { MaterialIcon } from "@/components/ui/material-icon";
import { useWorktreeFolder } from "@/hooks/remote/useWorktreeFolder";
import { cn } from "@/lib/utils";

// What every level of the tree reads the same: which worktree, what is
// open and picked, and what a click does. Only the folder and its
// depth change on the way down.
interface TreeCtx {
  projectId: string;
  worktreeId: string;
  selectedPath: string | null;
  expanded: ReadonlySet<string>;
  onToggleFolder: (path: string, open: boolean) => void;
  onSelectFile: (path: string) => void;
}

// The files page's rail: the worktree as a folder tree, read one folder
// at a time (sync:worktreeFolder) as folders are opened, so a
// node_modules costs nothing until someone opens it. Ignored entries
// are dimmed, which is the one thing the tree says about git.
//
// Rows are one flat run of buttons in document order, whatever their
// depth, which is what keeps the arrow keys a sibling query away.
export function FileTree({
  width,
  className,
  ...ctx
}: TreeCtx & {
  // Beside the viewer it is a rail the caller's separator drags. In the
  // phone layout's sheet it fills the width and `className` sizes it.
  width?: number;
  className?: string;
}) {
  const { expanded, onToggleFolder, selectedPath } = ctx;
  // The open file holds the tree's one tab stop while its row is on
  // screen. With its folder shut (or no file open) the first row takes
  // it, so Tab always has a way in.
  const tabStop =
    selectedPath !== null &&
    ancestorsOf(selectedPath).every((folder) => expanded.has(folder))
      ? selectedPath
      : null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [
      ...e.currentTarget.querySelectorAll<HTMLElement>("[data-tree-path]"),
    ];
    if (rows.length === 0) return;
    const at = rows.findIndex((row) => row === document.activeElement);
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
    <div
      data-slot="file-tree"
      role="tree"
      aria-label="Files"
      // The rows take the tab stop (see tabIndex on the row).
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={width === undefined ? undefined : { width }}
      className={cn("flex shrink-0 flex-col overflow-y-auto p-1", className)}
    >
      <FolderRows ctx={{ ...ctx, tabStop }} relative="" depth={0} />
    </div>
  );
}

function FolderRows({
  ctx,
  relative,
  depth,
}: {
  ctx: TreeCtx & { tabStop: string | null };
  relative: string;
  depth: number;
}) {
  const { selectedPath, expanded, onToggleFolder, onSelectFile, tabStop } = ctx;
  const { data, isPending, isError } = useWorktreeFolder(
    ctx.projectId,
    ctx.worktreeId,
    relative,
  );
  if (isPending) {
    return (
      <TreeNote depth={depth}>
        <Loader2 aria-hidden className="size-3 animate-spin" />
        Loading…
      </TreeNote>
    );
  }
  if (isError) return <TreeNote depth={depth}>Couldn't read folder</TreeNote>;
  if (data.length === 0) return <TreeNote depth={depth}>Empty</TreeNote>;
  return data.map((entry, index) => {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
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
          title={path}
          ref={selected ? revealRow : undefined}
          onClick={() =>
            entry.isDirectory ? onToggleFolder(path, !open) : onSelectFile(path)
          }
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          className={cn(
            "flex w-full shrink-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors",
            selected
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50 hover:text-foreground",
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
          <span className="min-w-0 flex-1 truncate font-mono text-2xs">
            {entry.name}
          </span>
        </button>
        {open && <FolderRows ctx={ctx} relative={path} depth={depth + 1} />}
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
function TreeNote({
  depth,
  children,
}: {
  depth: number;
  children: React.ReactNode;
}) {
  return (
    <div
      role="none"
      style={{ paddingLeft: `${depth * 12 + 22}px` }}
      className="flex shrink-0 items-center gap-1.5 py-1 text-2xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

// Every folder above a path, outermost first: what has to be open for
// the path's own row to be on screen.
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
