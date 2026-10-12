// The host beside GitHub's that images in a project's markdown may load
// from: its remote's (contracts' predicates/imageHosts.ts), on the
// device the page shows. Kept for the launch, as the remote rarely
// moves; none until it is known.
import { remoteHost } from "@shigomori/contracts/predicates/imageHosts";
import { skipToken, useQuery } from "@tanstack/react-query";
import { forestRead } from "@/hooks/remote/hostForestScope";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { queryKeysFor } from "@/lib/queryKeys";

const NONE: readonly string[] = [];

export function useProjectImageHosts(projectId: string): readonly string[] {
  const { deviceId, api } = useHostScope();
  const { data } = useQuery({
    queryKey: queryKeysFor(deviceId).cloneUrl(projectId),
    queryFn:
      api === undefined
        ? skipToken
        : ({ signal }) =>
            forestRead(deviceId, () =>
              api.run(api.projects.cloneUrl({ projectId }), { signal }),
            ),
    select: (url) => {
      const host = url === null ? null : remoteHost(url);
      return host === null ? NONE : [host];
    },
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    meta: { silentError: true },
  });
  return data ?? NONE;
}
