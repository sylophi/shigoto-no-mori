import type { DeviceIcon } from "@shared/account/deviceIcon";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
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
import type { Project } from "@shared/schemas";

interface ProjectMenuItemsProps {
  project: Project;
  // What sits under the cursor when the menu opens. Next to a worktree,
  // "Remove" reads as "delete this worktree", so the items that could be
  // taken either way name their target. Next to the project itself the
  // short forms are unambiguous.
  subject: "project" | "worktree";
  // The two-step remove confirm, owned by the menu's host so it can be
  // reset the moment the menu closes (see useProjectMenuRemoveArm).
  removeArm: ProjectMenuRemoveArm;
}

export type ProjectMenuRemoveArm = ReturnType<typeof useConfirmTwiceKeyed>;

const LABELS = {
  project: {
    quickCreate: "Quick create",
    configure: "Configure",
    remove: "Remove",
  },
  worktree: {
    quickCreate: "Quick create worktree",
    configure: "Configure project",
    remove: "Remove project",
  },
};

// Two-step confirm so accidentally landing on "Remove" doesn't drop the
// project. Menu stays open while armed; second click within the timeout
// fires the actual remove. The host wires `onOpenChange` to its menu
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
export function ProjectCreateMenuItems({
  project,
  subject,
}: Pick<ProjectMenuItemsProps, "project" | "subject">) {
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
        {LABELS[subject].quickCreate}
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
export function ProjectPageMenuItems({
  project,
  subject,
}: Pick<ProjectMenuItemsProps, "project" | "subject">) {
  const { toProjectPage } = useProjectNav();
  if (project.pathExists === false) return null;

  const goTo = (page: ProjectPage) => toProjectPage(page, project.id);

  return (
    <>
      <DropdownMenuItem onClick={() => goTo("convertExternal")}>
        Convert external worktrees
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => goTo("worktreeLocation")}>
        Set worktree location
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => goTo("branches")}>
        Manage branches
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => goTo("configure")}>
        {LABELS[subject].configure}
      </DropdownMenuItem>
    </>
  );
}

// The remove that closes the list, under the scope of the device it
// removes from. Plain, it reads "Remove". Given a `device` it is that
// device's row in a header's Remove submenu: named for the device,
// keyed by it in the shared arm, and red even when inert, as everything
// in that submenu is.
export function ProjectRemoveMenuItem({
  project,
  subject,
  removeArm,
  device,
}: ProjectMenuItemsProps & {
  device?: { id: string; label: string; icon: DeviceIcon };
}) {
  const armKey = device?.id ?? "";
  // The row is the device, so it leads with the device's glyph, like
  // every other list that names one.
  const deviceRow = device && (
    <>
      <DeviceGlyph icon={device.icon} className="size-3.5" />
      {device.label}
    </>
  );
  const removeProject = useRemoveProject();
  const armed = removeArm.armedKey === armKey;
  // A terrier-sourced project has nothing here to remove: its presence
  // is terrier's call (`terrier rm`), so say that instead of offering
  // a remove that the main process would refuse anyway.
  if (project.source === "terrier") {
    return device === undefined ? (
      <DropdownMenuItem disabled>Registered via terrier</DropdownMenuItem>
    ) : (
      <DropdownMenuItem variant="destructive" disabled>
        {deviceRow}
        <span className="ml-auto pl-3">via terrier</span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      variant="destructive"
      closeOnClick={armed}
      onClick={(event) => {
        if (!armed) event.preventDefault();
        removeArm.trigger(armKey, () => removeProject.mutate(project.id));
      }}
    >
      {armed ? "Click again to confirm" : (deviceRow ?? LABELS[subject].remove)}
    </DropdownMenuItem>
  );
}

// The whole action list under one scope, as the inbox row's right-click
// menu shows it (the project header composes the parts itself, across
// devices). Scope-aware through its hooks: mounted under a peer's
// HostScopeProvider every item acts on and links into that device.
export function ProjectMenuItems(props: ProjectMenuItemsProps) {
  const { project, subject } = props;
  return (
    <>
      <ProjectCreateMenuItems project={project} subject={subject} />
      <ProjectPageMenuItems project={project} subject={subject} />
      <ProjectRemoveMenuItem {...props} />
    </>
  );
}
