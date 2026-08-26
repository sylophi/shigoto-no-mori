import { useQuery } from "@tanstack/react-query";
import type { FsStat } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useFsStat(path: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<FsStat>({
    queryKey: keys.fsStat(path),
    queryFn: () => {
      if (!path) return { exists: false, isDirectory: false };
      return api.fs.stat(path);
    },
    enabled: path !== null,
    // Inline warning chip + icon resolution renders its own error state.
    meta: { silentError: true },
  });
}
