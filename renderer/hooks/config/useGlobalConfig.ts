import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GlobalConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useGlobalConfig() {
  return useQuery<GlobalConfig>({
    queryKey: queryKeys.globalConfig(),
    queryFn: () => window.api.globalConfig.read(),
    meta: { errorTitle: "Couldn't load settings" },
  });
}

export function useGlobalConfigWrite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: GlobalConfig) => {
      await window.api.globalConfig.write(config);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.globalConfig() });
      // Launcher catalogs for every project depend on global custom launchers.
      queryClient.invalidateQueries({ queryKey: queryKeys.launchersAll() });
      // Toggling the GitHub CLI integration flips both readiness gating
      // and the project PR list -- refetch immediately rather than wait
      // for the next focus/mount.
      queryClient.invalidateQueries({ queryKey: queryKeys.githubCliAll() });
    },
    meta: { errorTitle: "Couldn't save settings" },
  });
}
