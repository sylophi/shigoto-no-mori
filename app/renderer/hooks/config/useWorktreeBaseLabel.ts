// Where a project's new worktrees land on the scoped device, for
// display: the project's own layout (managed root, in-project, or a
// custom folder), spelled by the same rule the location page and the
// create itself use, and tildified against that device's home. Null
// until the device's runtime paths and settings are read.
import type { Project } from "@shared/schemas";
import { worktreeBaseLabel } from "@shared/git/worktreeLayout";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useDeviceLayout } from "@/hooks/config/useDeviceLayout";

export function useWorktreeBaseLabel(
  project: Pick<Project, "id" | "path">,
): string | null {
  const { data: config } = useShigomoriConfig(project.id);
  const device = useDeviceLayout();
  if (!device) return null;
  return worktreeBaseLabel(config ?? null, project.path, device);
}
