import { useQuery } from "@tanstack/react-query";
import type { FsStat } from "@shared/schemas";

export function useFsStat(path: string | null) {
  return useQuery<FsStat>({
    queryKey: ["fs", "stat", path],
    queryFn: () => {
      if (!path) return { exists: false, isDirectory: false };
      return window.api.fs.stat(path);
    },
    enabled: path !== null,
    // Warning chip + icon resolution in the carry-over section; the
    // global indicator would be misleading.
    meta: { silentError: true, silentSpinner: true },
  });
}
