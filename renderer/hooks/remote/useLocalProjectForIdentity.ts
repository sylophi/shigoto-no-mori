// The identity gate behind every bring-here / transplant control: a
// remote worktree can only land in a LOCAL project that is the same
// repo. The projects query is explicitly scope-less despite any
// surrounding HostScopeProvider (the destination is this machine), and
// on the web it stubs to [], so the controls structurally never render
// there. The handlers re-verify the match. This is UX, not the wall.
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@shared/schemas";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";

// The first local project sharing this repo identity, if any. A null
// identity (a project git couldn't identify) never matches, not even
// another null one.
export function useLocalProjectForIdentity(
  identity: string | null | undefined,
): Project | undefined {
  const { data: localProjects = [] } = useQuery(projectsQueryOptions({}));
  if (identity == null) return undefined;
  return localProjects.find((local) => local.identity === identity);
}
