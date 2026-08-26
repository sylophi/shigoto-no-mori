import { useQuery } from "@tanstack/react-query";
import type { FsListing } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useFsListEntries(path: string, enabled = true) {
  const { api, keys } = useHostScope();
  return useQuery<FsListing>({
    queryKey: keys.fsListEntries(path),
    queryFn: () => api.fs.listEntries(path),
    enabled,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
