import { useQuery } from "@tanstack/react-query";
import type { DirectoryListing } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useFsListDirectory(path: string, enabled = true) {
  const { api, keys } = useHostScope();
  return useQuery<DirectoryListing>({
    queryKey: keys.fsListDirectory(path),
    queryFn: () => api.fs.listDirectory(path),
    enabled,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
