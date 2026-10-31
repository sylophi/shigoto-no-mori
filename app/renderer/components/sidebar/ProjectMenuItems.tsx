import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DeviceMenuRowView } from "@shigomori/ui/views/sidebar/DeviceMenuRowView.tsx";
import {
  DropdownMenuArmedLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import {
  CONFIRM_QUICK_MS,
  useConfirmTwiceKeyed,
} from "@/hooks/ui/useConfirmTwice";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import {
  useProjectNav,
  type ProjectPage,
} from "@/hooks/projects/useProjectNav";
import { useRemoveProject } from "@/hooks/projects/useProjects";
import type { Project } from "@shigomori/contracts/schemas";

interface ProjectMenuItemsProps {
  project: Project;
  // The two-step remove confirm, owned by the menu's host so it can be
  // reset the moment the menu closes (see useProjectMenuRemoveArm).
  removeArm: ProjectMenuRemoveArm;
}

export type ProjectMenuRemoveArm = ReturnType<typeof useConfirmTwiceKeyed>;

// Two-step confirm so accidentally landing on a remove doesn't drop the
// project. The menu stays open while armed, and a second click within
// the timeout fires the actual remove. The host wires `onOpenChange` to its menu
// root so a leftover arm is cleared the instant the menu closes. The
// popup's own unmount comes only after its exit animation, and a reopen
// inside that window would otherwise find the item still armed. Keyed,
// so a menu listing several removes (the header's per-device submenu)
// holds one arm between them and can never have two half-confirmed.
export function useProjectMenuRemoveArm() {
  const removeArm = useConfirmTwiceKeyed(CONFIRM_QUICK_MS);
  const onOpenChange = (open: boolean) => {
    if (!open) removeArm.reset();
  };
  return { removeArm, onOpenChange };
}

// The create pair that leads the list. Its own component so a header
// spanning devices can mount it under the device its `+` creates on
// while the rest of the list stays with the device the menu opened for.
export function ProjectCreateMenuItems({ project }: { project: Project }) {
  const {
    quickCreate,
    openCreateForm,
    isPending: creating,
  } = useQuickCreateWorktree();
  if (project.pathExists === false) return null;

  return (
    <>
      <DropdownMenuItem
        disabled={creating}
        onClick={() => void quickCreate(project.id)}
      >
        Quick create
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => openCreateForm(project.id)}>
        New worktree from…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

// The project pages, behind the create pair. Each leads to a page with
// a device tab bar of its own (ProjectDevicePage), so the device the
// menu opened for is only where that page starts.
export function ProjectPageMenuItems({ project }: { project: Project }) {
  const { toProjectPage } = useProjectNav();
  if (project.pathExists === false) return null;

  const goTo = (page: ProjectPage) => toProjectPage(page, project.id);

  return (
    <>
      <DropdownMenuItem onClick={() => goTo("convertExternal")}>
        Convert external worktrees
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => goTo("branches")}>
        Manage branches
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => goTo("configure")}>
        Configure
      </DropdownMenuItem>
    </>
  );
}

// The removes that close the list, under the scope of the device they
// remove from. Plain, it reads "Unregister", or with `deleteFiles` "Delete
// from disk". Given a `device` it is that device's row in a header's
// submenu: named for the device and keyed by it in the shared arm.
export function ProjectRemoveMenuItem({
  project,
  removeArm,
  device,
  deleteFiles = false,
}: ProjectMenuItemsProps & {
  device?: { id: string; label: string; icon: DeviceIcon };
  deleteFiles?: boolean;
}) {
  const armKey = `${deleteFiles ? "delete:" : ""}${device?.id ?? ""}`;
  // The row is the device, so it leads with the device's glyph, like
  // every other list that names one.
  const deviceRow = device && (
    <DeviceMenuRowView icon={device.icon} label={device.label} />
  );
  const removeProject = useRemoveProject(deleteFiles);
  const armed = removeArm.armedKey === armKey;
  if (deleteFiles && project.pathExists === false) return null;
  return (
    <DropdownMenuItem
      variant="destructive"
      closeOnClick={armed}
      onClick={(event) => {
        if (!armed) event.preventDefault();
        removeArm.trigger(armKey, () => removeProject.mutate(project.id));
      }}
    >
      <DropdownMenuArmedLabel
        armed={armed}
        label={deviceRow ?? (deleteFiles ? "Delete from disk" : "Unregister")}
        armedLabel="Click again to confirm"
      />
    </DropdownMenuItem>
  );
}
