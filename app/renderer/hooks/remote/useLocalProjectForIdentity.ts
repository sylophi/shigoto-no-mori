// The identity gate behind every mirror / transplant control: a
// remote worktree can only land in a LOCAL project that is the same
// repo. The projects query is explicitly scope-less despite any
// surrounding HostScopeProvider (the destination is this machine), and
// the web has none, so the controls structurally never render there. The handlers re-verify the match. This is UX, not the wall.
import type { Project } from "@shigomori/contracts/schemas";
import { useDeviceProjects } from "@/hooks/projects/useProjects";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";

// The first local project sharing this repo identity, if any. A null
// identity (a project git couldn't identify) never matches, not even
// another null one.
export function useLocalProjectForIdentity(
  identity: string | null | undefined,
): Project | undefined {
  const { data: localProjects = [] } = useDeviceProjects(
    localDeviceId,
    hasLocalHost,
  );
  if (identity == null) return undefined;
  return localProjects.find((local) => local.identity === identity);
}
