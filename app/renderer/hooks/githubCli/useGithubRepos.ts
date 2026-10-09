import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The repositories the clone dialog offers, most recently pushed first.
// Quiet when it fails: a repository can still be typed in.
export function useGithubRepos(enabled: boolean) {
  const { api, keys } = useHostScope();
  return useQuery<readonly string[]>({
    queryKey: keys.githubRepos(),
    queryFn: () => api.githubCli.repos(),
    enabled,
    // Fetched again when the dialog opens after a while, so a repository
    // made since shows up, and not on every focus or change of mode.
    staleTime: 5 * 60_000,
    meta: { silentError: true },
  });
}
