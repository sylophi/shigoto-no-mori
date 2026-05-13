import { useQuery } from "@tanstack/react-query";
import type { DirectoryListing } from "@shared/schemas";

export function useFsListDirectory(path: string, enabled = true) {
  return useQuery<DirectoryListing>({
    queryKey: ["fs", "listDirectory", path],
    queryFn: () => window.api.fs.listDirectory(path),
    enabled,
    staleTime: 5_000,
  });
}
