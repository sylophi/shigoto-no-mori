import { useQuery } from "@tanstack/react-query";
import type { GithubCliReadiness } from "@shared/schemas";

export function useGithubCliReadiness() {
  return useQuery<GithubCliReadiness>({
    queryKey: ["githubCliReadiness"],
    queryFn: () => window.api.githubCli.readiness(),
    meta: { errorTitle: "Couldn't check GitHub CLI status" },
  });
}
