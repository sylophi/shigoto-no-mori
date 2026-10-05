// "Locate…" for a missing project: pick the folder its repo was moved
// or renamed to, and the project points there from then on, its
// worktrees and settings with it (`sm projects relocate`). Mounted under
// the scope of the device holding the project, so the picker browses
// that device's disk and the relocation runs there.
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { useRelocateProject } from "@/hooks/projects/useProjects";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { getBrowseParentPath } from "@shared/projectPaths";
import type { Project } from "@shared/schemas";

// Where the picker opens: the closest folder above the old path that is
// still there, the usual neighbourhood of a move or a rename. A parent
// that went too would open the picker on an error. Undefined, the
// picker opens at home.
export async function locateStartFolder(
  api: HostApi,
  path: string,
): Promise<string | undefined> {
  for (
    let dir = getBrowseParentPath(path);
    dir !== null;
    dir = getBrowseParentPath(dir)
  ) {
    // oxlint-disable-next-line no-await-in-loop -- nearest first, and the first that lists ends the walk.
    const listed = await api.fs.listDirectory(dir).then(
      () => true,
      () => false,
    );
    if (listed) return dir;
  }
  return undefined;
}

export function LocateProjectPicker({
  project,
  from,
  onClose,
}: {
  project: Project;
  from: string | undefined;
  onClose: () => void;
}) {
  const relocate = useRelocateProject(project.id);
  return (
    <FolderPickerModal
      initialPath={from}
      title={`Locate ${project.name}`}
      hint={`${project.path} is gone. Pick the folder the repo is in now. Its worktrees and settings come along.`}
      onPick={(path) => {
        onClose();
        relocate.mutate(path);
      }}
      onClose={onClose}
    />
  );
}
