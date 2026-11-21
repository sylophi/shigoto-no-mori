import { useQuery } from "@tanstack/react-query";
import type { Volume } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The volumes a browse offers to jump to. Quiet and asked once when it
// fails: a peer on a build without the call browses as before. Kept a
// while, since a Windows host probes each drive letter for it.
export function useFsListVolumes(enabled = true) {
  const { api, keys } = useHostScope();
  return useQuery<readonly Volume[]>({
    queryKey: keys.fsListVolumes(),
    queryFn: ({ signal }) => api.run(api.fs.listVolumes(), { signal }),
    enabled,
    staleTime: 15_000,
    retry: false,
    meta: { silentError: true },
  });
}
