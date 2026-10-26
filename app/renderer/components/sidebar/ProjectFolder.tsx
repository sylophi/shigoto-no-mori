// The folders on the list of projects (useProjectFolders): a folder's
// header, with its rename and ungroup, a project's pick of folder, and
// the dialog naming a folder, which the shell mounts (FolderNameDialog)
// so it outlasts the row it was asked for from.
import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import type { SidebarRow } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import {
  FolderNameDialogView,
  ProjectFolderHeaderView,
  ProjectFolderSubmenuView,
} from "@shigomori/ui/views/sidebar/ProjectFolderView.tsx";
import { useSetProjectFolder } from "@/hooks/sharedSettings/useProjectFolders";

// The projects being named a folder for, and the folder's name when
// it is a rename (null: a new one).
const namingAtom = Atom.keepAlive(
  Atom.make<{ groupKeys: readonly string[]; name: string | null } | null>(null),
);

export function ProjectFolderHeader({
  row,
  onToggle,
}: {
  row: Extract<SidebarRow, { kind: "project-folder" }>;
  onToggle: () => void;
}) {
  const setFolder = useSetProjectFolder();
  const setNaming = useAtomSet(namingAtom);
  return (
    <ProjectFolderHeaderView
      name={row.name}
      count={row.count}
      expanded={row.expanded}
      onToggle={onToggle}
      onRename={() => setNaming({ groupKeys: row.groupKeys, name: row.name })}
      onUngroup={() => setFolder(row.groupKeys, null)}
    />
  );
}

export function ProjectFolderSubmenu({
  groupKey,
  folder,
  folders,
}: {
  groupKey: string;
  folder: string | null;
  folders: readonly string[];
}) {
  const setFolder = useSetProjectFolder();
  const setNaming = useAtomSet(namingAtom);
  return (
    <ProjectFolderSubmenuView
      folder={folder}
      folders={folders}
      onPick={(name) => setFolder([groupKey], name)}
      onNewFolder={() => setNaming({ groupKeys: [groupKey], name: null })}
    />
  );
}

export function FolderNameDialog() {
  const naming = useAtomValue(namingAtom);
  const setNaming = useAtomSet(namingAtom);
  if (naming === null) return null;
  return (
    <FolderNameDialogShell
      groupKeys={naming.groupKeys}
      initial={naming.name}
      onClose={() => setNaming(null)}
    />
  );
}

function FolderNameDialogShell({
  groupKeys,
  initial,
  onClose,
}: {
  groupKeys: readonly string[];
  initial: string | null;
  onClose: () => void;
}) {
  const setFolder = useSetProjectFolder();
  const [name, setName] = useState(initial ?? "");
  const title = initial === null ? "New folder" : "Rename folder";
  return (
    <ModalShell label={title} onClose={onClose} popoverClassName="max-w-sm">
      <FolderNameDialogView
        title={title}
        verb={initial === null ? "Create" : "Rename"}
        name={name}
        onNameChange={setName}
        onSave={() => {
          setFolder(groupKeys, name.trim());
          onClose();
        }}
        onCancel={onClose}
      />
    </ModalShell>
  );
}
