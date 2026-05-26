import { useQuery } from "@tanstack/react-query";
import type { FsListing } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useFsListEntries(path: string, enabled = true) {
  return useQuery<FsListing>({
    queryKey: queryKeys.fsListEntries(path),
    queryFn: () => window.api.fs.listEntries(path),
    enabled,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
