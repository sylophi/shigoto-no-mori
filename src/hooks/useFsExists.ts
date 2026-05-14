import { useQuery } from "@tanstack/react-query";

export function useFsExists(path: string | null) {
  return useQuery<boolean>({
    queryKey: ["fs", "exists", path],
    queryFn: () => {
      if (!path) return false;
      return window.api.fs.exists(path);
    },
    enabled: path !== null,
    // Warning chip in the carry-over section; the global indicator would
    // be misleading since this query is invisible to the user.
    meta: { silentError: true, silentSpinner: true },
  });
}
