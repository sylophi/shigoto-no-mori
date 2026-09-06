import { Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import type { Project } from "@shared/schemas";
import { PROJECT_MENU_TRIGGER_CLASS } from "./sidebarChrome";

// The project header's `+`: a quick create off the default branch, or
// the full form on a modified click. Scope-aware through the hook, so
// the same button serves a local header and a remote one mounted under
// its device's HostScopeProvider. Hover-revealed like the `…` beside
// it, and always shown on a phone, where there is no hover.
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
  const label = deviceLabel
    ? `Quick-create worktree in ${project.name} on ${deviceLabel}`
    : `Quick-create worktree in ${project.name}`;
  return (
    <button
      type="button"
      onClick={(event) => createFrom(event, project.id)}
      disabled={creating}
      aria-label={label}
      title={label}
      className={cn(
        PROJECT_MENU_TRIGGER_CLASS,
        "disabled:cursor-not-allowed disabled:opacity-100 aria-busy:opacity-100",
        isHovered ? "opacity-100" : "opacity-0",
      )}
      aria-busy={creating}
    >
      {creating ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Plus className="size-3.5" />
      )}
    </button>
  );
}
