import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { LAYOUT_OPTIONS } from "@/components/worktreeLocation/layoutOptions";
import { useDeviceLayout } from "@/hooks/config/useDeviceLayout";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { projectDriveBaseFor } from "@shared/git/worktreeLayout";
import type { ShigomoriConfig } from "@shared/schemas";

// Which layout the project's worktrees use, as the saved config has it.
// The pick itself lives on a subpage: changing it can move worktrees,
// and the subpage lists each one with where it goes.
export function WorktreeLocationField({
  projectId,
  projectPath,
  config,
  home,
  blocked,
}: {
  projectId: string;
  projectPath: string;
  config: ShigomoriConfig | null;
  home: string | null;
  // The form around it has unsaved edits, which leaving for the
  // subpage would throw away.
  blocked: boolean;
}) {
  const { toProjectPage } = useProjectNav();
  const device = useDeviceLayout();
  const layout = config?.worktreeLayout ?? "managed-root";
  const option = LAYOUT_OPTIONS.find((o) => o.value === layout);
  // A custom layout has no description. Its folder says more, and so
  // does the one the managed layout keeps on the project's drive.
  const customPath =
    layout === "custom" ? config?.customWorktreePath?.trim() : undefined;
  const drivePath =
    layout === "managed-root" && device?.onProjectDrive
      ? projectDriveBaseFor(projectPath, device)
      : null;
  const shownPath = customPath || drivePath;

  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">Location</span>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm">{option?.label}</span>
          {shownPath ? (
            <PathSpan
              path={shownPath}
              home={home}
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            />
          ) : (
            option?.description && (
              <span className="text-xs text-muted-foreground">
                {option.description}
              </span>
            )
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={blocked}
          title={blocked ? "Save or discard your changes first" : undefined}
          onClick={() => toProjectPage("worktreeLocation", projectId)}
        >
          Change…
        </Button>
      </div>
    </div>
  );
}
