import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function useFsIsGitRepo(path: string, enabled = true) {
  return useQuery<boolean>({
    queryKey: queryKeys.fsIsGitRepo(path),
    queryFn: () => window.api.fs.isGitRepo(path),
    enabled: enabled && path.length > 0,
    // Boolean UI hint — failure falls back to "not a repo" cleanly.
    meta: { silentError: true },
  });
}
