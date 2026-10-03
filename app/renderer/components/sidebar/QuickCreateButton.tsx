import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import type { Project } from "@shared/schemas";
import {
  QuickCreateButtonView,
  quickCreateLabel,
} from "./ProjectGroupActionsView";

// The project header's `+` (QuickCreateButtonView): a quick create off
// the default branch, or the full form on a modified click.
// Scope-aware through the hook, so the same button serves a local
// header and a remote one mounted under its device's HostScopeProvider.
export function QuickCreateButton({
  project,
  isHovered,
  // Names the device in the label when the header spans several.
  deviceLabel,
}: {
  project: Project;
  isHovered: boolean;
  deviceLabel?: string;
}) {
  const { createFrom, isPending: creating } = useQuickCreateWorktree();
  return (
    <QuickCreateButtonView
      label={quickCreateLabel(project.name, deviceLabel)}
      creating={creating}
      isHovered={isHovered}
      onClick={(event) => createFrom(event, project.id)}
    />
  );
}
