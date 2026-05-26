import { useQuery } from "@tanstack/react-query";
import type { GithubCliReadiness } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useGithubCliReadiness() {
  return useQuery<GithubCliReadiness>({
    queryKey: queryKeys.githubCliReadiness(),
    queryFn: () => window.api.githubCli.readiness(),
    meta: { errorTitle: "Couldn't check GitHub CLI status" },
  });
}
