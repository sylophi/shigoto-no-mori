import { useQuery } from "@tanstack/react-query";
import type { FsListing } from "@shared/schemas";

export function useFsListEntries(path: string, enabled = true) {
  return useQuery<FsListing>({
    queryKey: ["fs", "listEntries", path],
    queryFn: () => window.api.fs.listEntries(path),
    enabled,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
