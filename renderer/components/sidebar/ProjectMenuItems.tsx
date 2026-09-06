import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
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
  removeArm: ReturnType<typeof useConfirmTwice>;
}

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
// root so a leftover arm is cleared the instant the menu closes -- the
// popup's own unmount comes only after its exit animation, and a reopen
// inside that window would otherwise find the item still armed.
export function useProjectMenuRemoveArm() {
  const removeArm = useConfirmTwice(CONFIRM_QUICK_MS);
  const onOpenChange = (open: boolean) => {
    if (!open) removeArm.reset();
  };
  return { removeArm, onOpenChange };
}

// The project's action list, shared by the header's `…` dropdown and the
// inbox row's right-click menu. Scope-aware through its hooks: mounted
// under a peer's HostScopeProvider (a remote project header, a peer's
// inbox row) every item acts on and links into that device.
export function ProjectMenuItems({
  project,
  subject,
  removeArm: { armed: removeArmed, trigger: triggerRemove },
}: ProjectMenuItemsProps) {
  const { toProjectPage } = useProjectNav();
  const labels = LABELS[subject];
  const missing = project.pathExists === false;
  const fromTerrier = project.source === "terrier";
  const removeProject = useRemoveProject();
  const {
    quickCreate,
    openCreateForm,
    isPending: creating,
  } = useQuickCreateWorktree();

  const goTo = (page: ProjectPage) => toProjectPage(page, project.id);

  return (
    <>
      {!missing && (
        <>
          <DropdownMenuItem
            disabled={creating}
            onClick={() => void quickCreate(project.id)}
          >
            {labels.quickCreate}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openCreateForm(project.id)}>
            New worktree from…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
            {labels.configure}
          </DropdownMenuItem>
        </>
      )}
      {/* A terrier-sourced project has nothing here to remove: its presence
          is terrier's call (`terrier rm`), so say that instead of offering
          a remove that the main process would refuse anyway. */}
      {fromTerrier ? (
        <DropdownMenuItem disabled>Registered via terrier</DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          variant="destructive"
          closeOnClick={removeArmed}
          onClick={(event) => {
            if (!removeArmed) event.preventDefault();
            triggerRemove(() => removeProject.mutate(project.id));
          }}
        >
          {removeArmed ? "Click again to confirm" : labels.remove}
        </DropdownMenuItem>
      )}
    </>
  );
}
