// Where a project's new worktrees land on the scoped device, for
// display: the project's own layout (managed root, in-project, or a
// custom folder), spelled by the same rule the location page and the
// create itself use, and tildified against that device's home. Null
// until the device's runtime paths are read.
import type { Project } from "@shared/schemas";
import { layoutInputsFor, worktreeBaseFor } from "@shared/git/worktreeLayout";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { tildify } from "@/lib/projectPaths";

export function useWorktreeBaseLabel(
  project: Pick<Project, "id" | "path">,
): string | null {
  const { data: config } = useShigomoriConfig(project.id);
  const { data: runtime } = useRuntimeInfo();
  if (!runtime) return null;
  return tildify(
    worktreeBaseFor(
      layoutInputsFor(config ?? null, project.path, runtime.dataDir),
    ),
    runtime.homedir,
  );
}
