import { queryOptions, useQuery } from "@tanstack/react-query";
import { useHostScope, type HostScope } from "@/hooks/remote/useHostScope";

// Shared with the add-project flow's ↩, which asks outside a hook when
// the hint below hasn't caught up with the input yet.
export function fsIsGitRepoQueryOptions(
  path: string,
  { api, keys }: Pick<HostScope, "api" | "keys">,
) {
  return queryOptions<boolean>({
    queryKey: keys.fsIsGitRepo(path),
    queryFn: () => api.fs.isGitRepo(path),
    // Boolean UI hint. Failure falls back to "not a repo" cleanly.
    meta: { silentError: true },
  });
}

export function useFsIsGitRepo(path: string, enabled = true) {
  const scope = useHostScope();
  return useQuery({
    ...fsIsGitRepoQueryOptions(path, scope),
    enabled: enabled && path.length > 0,
  });
}
