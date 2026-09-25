import { useQuery } from "@tanstack/react-query";
import type { GithubCliReadiness } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useGithubCliReadiness() {
  const { api, keys } = useHostScope();
  return useQuery<GithubCliReadiness>({
    queryKey: keys.githubCliReadiness(),
    queryFn: () => api.githubCli.readiness(),
    meta: { errorTitle: "Couldn't check GitHub CLI status" },
  });
}
