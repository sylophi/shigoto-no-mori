import { useWorktreeFolder } from "@/hooks/remote/useWorktreeFolder";
import {
  FileTreeNoteView,
  FileTreeRowsView,
  FileTreeView,
} from "@shigomori/ui/views/files/FileTreeView.tsx";
import { ancestorsOf } from "@shigomori/ui/views/files/treePaths.ts";

// What every level of the tree reads the same: which worktree, what is
// open and picked, and what a click does. Only the folder and its
// depth change on the way down.
interface TreeCtx {
  projectId: string;
  worktreeId: string;
  selectedPath: string | null;
  expanded: ReadonlySet<string>;
  hideIgnored: boolean;
  onToggleFolder: (path: string, open: boolean) => void;
  onSelectFile: (path: string) => void;
  // Opens a file in the editor, on a double click or from its menu.
  // Absent where the files aren't this machine's.
  onOpenFile: ((path: string) => void) | undefined;
}

// The files page's list: the worktree as a folder tree, read one folder
// at a time (sync:worktreeFolder) as folders are opened, so a
// node_modules costs nothing until someone opens it. Ignored entries
// are dimmed or left out, which is the one thing the tree says about
// git.
//
// Rows are one flat run of buttons in document order, whatever their
// depth, which is what keeps the arrow keys a sibling query away. Where
// files open in the editor, a file's right click opens one menu the
// whole tree shares, anchored at the pointer, like the diff's file list.
export function FileTree({
  className,
  ...ctx
}: TreeCtx & {
  // The box is the caller's: the app sidebar's slot on a wide viewport,
  // the page itself or its sheet on a phone.
  className?: string;
}) {
  const { expanded, onToggleFolder, selectedPath, onOpenFile } = ctx;
  // The open file holds the tree's one tab stop while its row is on
  // screen. With its folder shut (or no file open) the first row takes
  // it, so Tab always has a way in.
  const tabStop =
    selectedPath !== null &&
    ancestorsOf(selectedPath).every((folder) => expanded.has(folder))
      ? selectedPath
      : null;
  return (
    <FileTreeView
      expanded={expanded}
      onToggleFolder={onToggleFolder}
      onOpenFile={onOpenFile}
      className={className}
    >
      {(menuPath) => (
        <FolderRows ctx={{ ...ctx, tabStop, menuPath }} relative="" depth={0} />
      )}
    </FileTreeView>
  );
}

function FolderRows({
  ctx,
  relative,
  depth,
}: {
  // menuPath is the file whose menu is up: its row stays lit while it is.
  ctx: TreeCtx & { tabStop: string | null; menuPath: string | null };
  relative: string;
  depth: number;
}) {
  const {
    selectedPath,
    expanded,
    hideIgnored,
    onToggleFolder,
    onSelectFile,
    onOpenFile,
    tabStop,
    menuPath,
  } = ctx;
  const { data, isPending, isError } = useWorktreeFolder(
    ctx.projectId,
    ctx.worktreeId,
    relative,
    false,
  );
  if (isPending) {
    return (
      <FileTreeNoteView depth={depth} loading>
        Loading…
      </FileTreeNoteView>
    );
  }
  if (isError) {
    return (
      <FileTreeNoteView depth={depth}>Couldn't read folder</FileTreeNoteView>
    );
  }
  const pathOf = (name: string) => (relative ? `${relative}/${name}` : name);
  // The open file and the folders down to it stay, so a linked ignored
  // file still has its row.
  const leadsToSelected = (path: string) =>
    selectedPath === path || !!selectedPath?.startsWith(`${path}/`);
  const entries = hideIgnored
    ? data.filter((e) => !e.ignored || leadsToSelected(pathOf(e.name)))
    : data;
  if (entries.length === 0) {
    return (
      <FileTreeNoteView depth={depth}>
        {data.length === 0 ? "Empty" : "Only ignored files"}
      </FileTreeNoteView>
    );
  }
  return (
    <FileTreeRowsView
      parent={relative}
      entries={entries}
      depth={depth}
      selectedPath={selectedPath}
      expanded={expanded}
      tabStop={tabStop}
      menuPath={menuPath}
      onToggleFolder={onToggleFolder}
      onSelectFile={onSelectFile}
      onOpenFile={onOpenFile}
      renderFolder={(path) => (
        <FolderRows ctx={ctx} relative={path} depth={depth + 1} />
      )}
    />
  );
}
