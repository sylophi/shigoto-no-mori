import { useQuery } from "@tanstack/react-query";
import type { DirectoryListing } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useFsListDirectory(path: string, enabled = true) {
  const { api, keys } = useHostScope();
  return useQuery<DirectoryListing>({
    queryKey: keys.fsListDirectory(path),
    queryFn: ({ signal }) =>
      api.run(api.fs.listDirectory({ path }), { signal }),
    enabled,
    meta: { errorTitle: "Couldn't read folder" },
  });
}
