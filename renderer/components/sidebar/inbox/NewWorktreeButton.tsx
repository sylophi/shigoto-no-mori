import { Folder, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import type { Project } from "@shared/schemas";
import { ProjectIcon } from "../ProjectIcon";

interface NewWorktreeButtonProps {
  projects: Project[];
}

// The inbox view's create affordance. Classic view hangs a + off each
// project header. The inbox has none, so the destination has to be
// picked here: one project means there's nothing to pick and the button
// creates outright, several open a menu. Either way a modified click
// lands on the full form instead of quick-creating, matching the
// project row's + button.
export function NewWorktreeButton({ projects }: NewWorktreeButtonProps) {
  const { quickCreate, openCreateForm, isPending } = useQuickCreateWorktree();
  const targets = projects.filter((p) => p.pathExists !== false);
  const label = isPending ? "Creating worktree…" : "New worktree";

  const face = (
    <>
      {isPending ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : (
        <Plus aria-hidden />
      )}
      {label}
    </>
  );

  const dispatch = (projectId: string, modified: boolean) => {
    if (modified) openCreateForm(projectId);
    else void quickCreate(projectId);
  };

  // Nothing to pick between: create outright, or sit disabled with no
  // menu behind it when there's no project to create in at all.
  if (targets.length <= 1) {
    const only = targets[0];
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={!only || isPending}
        aria-busy={isPending}
        title={
          only
            ? `New worktree in ${only.name} (hold ⇧ to pick a base)`
            : "Add a project first"
        }
        onClick={(e) =>
          only && dispatch(only.id, e.shiftKey || e.metaKey || e.ctrlKey)
        }
        className="w-full"
      >
        {face}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            aria-busy={isPending}
            aria-label="New worktree"
            className="w-full"
          >
            {face}
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4}>
        {/* GroupLabel throws outside a Group -- Base UI reads the group
            context to wire the label to the items it names. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            New worktree in… (⇧ to pick a base)
          </DropdownMenuLabel>
          {targets.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onClick={(event) =>
                dispatch(
                  project.id,
                  event.shiftKey || event.metaKey || event.ctrlKey,
                )
              }
            >
              {/* Fallback so every row is icon-then-name: without it the
                  projects with no detected icon start at a different x
                  and the menu reads as two ragged columns. */}
              <ProjectIcon projectId={project.id} fallback={Folder} />
              {project.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
