// "Locate…" for a missing project: pick the folder its repo was moved
// or renamed to, and the project points there from then on, its
// worktrees and settings with it (`sm projects relocate`). Mounted under
// the scope of the device holding the project, so the picker browses
// that device's disk and the relocation runs there.
import { useState, type ReactNode } from "react";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import {
  useRelocateProject,
  useRelocatingProject,
} from "@/hooks/projects/useProjects";
import { MaybeHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { getBrowseParentPath } from "@shared/projectPaths";
import type { Project } from "@shared/schemas";
import type { GroupMember } from "./ProjectGroupActions";

// Locate for a project group's header, the sidebar's row and the home
// page's tile alike. A missing checkout can be pointed at where its
// repo went, over the session of the device holding it. Terrier's are
// terrier's to move. `onLocate` is set while it can be located, and
// `picker` is the open picker to render.
export function useLocateProject(
  group: readonly GroupMember[],
  project: Project,
  missing: boolean,
): {
  relocating: boolean;
  onLocate: (() => void) | undefined;
  picker: ReactNode;
} {
  const holder = group[0];
  // One relocation at a time: the row reads as missing until it lands.
  const relocating = useRelocatingProject(
    holder?.deviceId ?? "",
    holder?.project.id ?? "",
  );
  const locateApi =
    missing && project.source !== "terrier" && !relocating
      ? holder?.api
      : undefined;
  // Open, from where the picker starts once that is found.
  const [locating, setLocating] = useState<{ from: string | undefined }>();
  const onLocate =
    holder !== undefined && locateApi !== undefined
      ? () =>
          void locateStartFolder(locateApi, holder.project.path).then((from) =>
            setLocating({ from }),
          )
      : undefined;
  const picker = locating !== undefined &&
    holder !== undefined &&
    locateApi && (
      <MaybeHostScope deviceId={holder.deviceId} api={locateApi}>
        <LocateProjectPicker
          project={holder.project}
          from={locating.from}
          onClose={() => setLocating(undefined)}
        />
      </MaybeHostScope>
    );
  return { relocating, onLocate, picker };
}

// Where the picker opens: the closest folder above the old path that is
// still there, the usual neighbourhood of a move or a rename. A parent
// that went too would open the picker on an error. Undefined, the
// picker opens at home.
async function locateStartFolder(
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

function LocateProjectPicker({
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
