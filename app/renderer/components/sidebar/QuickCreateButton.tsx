// The project header's `+` (QuickCreateButtonView). Scope-aware through
// the hook, so the same button serves a local header and a remote one
// mounted under its device's HostScopeProvider.
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import type { Project } from "@shigomori/contracts/schemas";
import { QuickCreateButtonView } from "@shigomori/ui/views/sidebar/QuickCreateButtonView.tsx";

export function QuickCreateButton({
  project,
  isHovered,
  deviceLabel,
}: {
  project: Project;
  isHovered: boolean;
  deviceLabel?: string;
}) {
  const { createFrom, isPending } = useQuickCreateWorktree();
  return (
    <QuickCreateButtonView
      name={project.name}
      isHovered={isHovered}
      deviceLabel={deviceLabel}
      creating={isPending}
      onClick={(event) => createFrom(event, project.id)}
    />
  );
}
