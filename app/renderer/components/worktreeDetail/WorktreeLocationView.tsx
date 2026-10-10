// Where a worktree lives, at the end of its page's breadcrumb, and its
// folder renamed in place there (WorktreeLocation binds it). The pencil
// shows on hover, beside the path's copy button, and the editor takes
// the path's place with the folder's name, the one thing a rename
// changes. A phone has no room for the path, so neither shows there.
import { Pencil } from "lucide-react";
import { InlineNameEditorView } from "@shigomori/ui/views/shared/InlineNameEditorView.tsx";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { PathSpan } from "@shigomori/ui/primitives/path-span.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

export function WorktreeLocationView({
  path,
  home,
  rename,
}: {
  path: string;
  // This device's home, which the path shortens to ~.
  home: string | null;
  // Absent where the folder can't be renamed (the primary checkout, a
  // peer that takes no commands).
  rename?: {
    editing: boolean;
    onEditingChange: (next: boolean) => void;
    pending: boolean;
    onRename: (name: string) => void;
  };
}) {
  const folder = path.slice(path.lastIndexOf("/") + 1);
  if (rename?.editing) {
    return (
      <span className="min-w-0 flex-1 phone:hidden">
        <InlineNameEditorView
          name={folder}
          label="Folder"
          pending={rename.pending}
          onSave={rename.onRename}
          onCancel={() => rename.onEditingChange(false)}
          className="w-40 font-mono text-xs"
        />
      </span>
    );
  }
  return (
    <span className="group/rename flex min-w-0 flex-1 items-center phone:hidden">
      <PathSpan
        path={path}
        home={home}
        className="min-w-0 font-mono"
        copyable
      />
      {rename && (
        <SimpleTooltip tip="Rename folder">
          <IconButton
            aria-label={`Rename ${folder}`}
            onClick={() => rename.onEditingChange(true)}
            className="shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/rename:opacity-100 focus-visible:opacity-100"
          >
            <Pencil className="size-3.5" />
          </IconButton>
        </SimpleTooltip>
      )}
    </span>
  );
}
