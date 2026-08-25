import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useFsIsGitRepo(path: string, enabled = true) {
  const { api, keys } = useHostScope();
  return useQuery<boolean>({
    queryKey: keys.fsIsGitRepo(path),
    queryFn: () => api.fs.isGitRepo(path),
    enabled: enabled && path.length > 0,
    // Boolean UI hint — failure falls back to "not a repo" cleanly.
    meta: { silentError: true },
  });
}
