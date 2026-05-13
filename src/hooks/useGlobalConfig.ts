import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GlobalConfig } from "@shared/schemas";

const QUERY_KEY = ["globalConfig"] as const;

export function useGlobalConfig() {
  return useQuery<GlobalConfig>({
    queryKey: QUERY_KEY,
    queryFn: () => window.api.globalConfig.read(),
    staleTime: 30_000,
  });
}

export function useGlobalConfigWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: GlobalConfig) => {
      await window.api.globalConfig.write(config);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      // Launcher catalogs for every project depend on global custom launchers.
      qc.invalidateQueries({ queryKey: ["launchers"] });
    },
  });
}
