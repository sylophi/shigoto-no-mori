import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublishRepoPayload } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { type Abortable, abortable, withAbort } from "@/lib/cancellable";

// The accounts a new repository can go under, signed-in user first.
// Asked only once publishing is on the table. Quiet when it fails: the
// publish goes under gh's own user without it.
export function useGithubOwners(enabled: boolean) {
  const { api, keys } = useHostScope();
  return useQuery<readonly string[]>({
    queryKey: keys.githubOwners(),
    queryFn: ({ signal }) => api.run(api.githubCli.owners(), { signal }),
    enabled,
    staleTime: Infinity,
    meta: { silentError: true },
  });
}

// Creates the project's repo on GitHub and pushes it there. The project
// gains a remote, which its group in the sidebar and every GitHub read
// follow. `cancel` stops it, which can leave the repo made and its push
// for the branch's Publish.
export function usePublishRepo() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  const mutation = useMutation<void, Error, Abortable<PublishRepoPayload>>({
    mutationFn: abortable((input: PublishRepoPayload, signal) =>
      api.run(api.githubCli.publish(input), { signal }),
    ),
    onSuccess: (_data, { projectId }) =>
      Promise.all(
        [
          keys.pullRequestsForProject(projectId),
          keys.repoDescription(projectId),
          keys.repoMergeConfig(projectId),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    // The caller says what failed: the project exists either way.
    meta: { silentError: true },
  });
  return withAbort(mutation);
}
