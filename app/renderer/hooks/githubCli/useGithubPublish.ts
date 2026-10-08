import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublishRepoPayload } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The accounts a new repository can go under, signed-in user first.
// Asked only once publishing is on the table. Quiet when it fails: the
// publish goes under gh's own user without it.
export function useGithubOwners(enabled: boolean) {
  const { api, keys } = useHostScope();
  return useQuery<string[]>({
    queryKey: keys.githubOwners(),
    queryFn: () => api.githubCli.owners(),
    enabled,
    staleTime: Infinity,
    meta: { silentError: true },
  });
}

// Creates the project's repo on GitHub and pushes it there. The project
// gains a remote, which its group in the sidebar and every GitHub read
// follow.
export function usePublishRepo() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<void, Error, PublishRepoPayload>({
    mutationFn: (input) => api.githubCli.publish(input),
    onSuccess: (_data, { projectId }) =>
      Promise.all(
        [
          keys.projects(),
          keys.pullRequestsForProject(projectId),
          keys.repoDescription(projectId),
          keys.repoMergeConfig(projectId),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    // The caller says what failed: the project exists either way.
    meta: { silentError: true },
  });
}
