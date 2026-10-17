// An image a project's markdown names on a host other than GitHub's,
// read by the device the page shows (projects:remoteImage), which
// refuses any host but the project's remotes'. Kept with the query
// cache, so a description shown again draws without asking.
import { useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useRemoteImage(
  projectId: string,
): (url: string) => Promise<string> {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return (url) => {
    const queryKey = keys.remoteImage(projectId, url);
    // One the device refused or couldn't read stays blank while the
    // cache keeps it, rather than asked again at every render.
    const last = queryClient.getQueryState(queryKey);
    if (last?.status === "error") return Promise.reject(last.error);
    return queryClient.fetchQuery({
      queryKey,
      queryFn: ({ signal }) =>
        api.run(api.projects.remoteImage({ projectId, url }), { signal }),
      staleTime: Infinity,
      retry: false,
      // A refused or unreadable image stays blank, which says so.
      meta: { silentError: true },
    });
  };
}
