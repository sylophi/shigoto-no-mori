// Where a project's new worktrees land on the scoped device, for
// display: the project's own layout (managed root, in-project, or a
// custom folder), spelled by the same rule the location page and the
// create itself use, and shown as that device shows it, ending in its
// separator. Null until the device's runtime paths and settings are
// read.
import type { Project } from "@shigomori/contracts/schemas";
import { worktreeBase } from "@shigomori/contracts/git/worktreeLayout";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useDeviceLayout } from "@/hooks/config/useDeviceLayout";
import { shownPath } from "@shigomori/ui/lib/devicePaths.ts";

export function useWorktreeBaseLabel(
  project: Pick<Project, "id" | "path">,
): string | null {
  const { data: config } = useShigomoriConfig(project.id);
  const device = useDeviceLayout();
  if (!device) return null;
  return shownPath(
    `${worktreeBase({
      ...device,
      layout: config?.worktreeLayout,
      projectPath: project.path,
      customPath: config?.customWorktreePath,
    })}/`,
    device.homedir,
  );
}
