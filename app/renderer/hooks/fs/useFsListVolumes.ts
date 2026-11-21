import { useQuery } from "@tanstack/react-query";
import type { Volume } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The volumes a browse offers to jump to. Quiet when it fails: a peer
// on a build without the call, or one that can't run `mount`, browses
// as before.
export function useFsListVolumes(enabled = true) {
  const { api, keys } = useHostScope();
  return useQuery<readonly Volume[]>({
    queryKey: keys.fsListVolumes(),
    queryFn: ({ signal }) => api.run(api.fs.listVolumes(), { signal }),
    enabled,
    meta: { silentError: true },
  });
}
