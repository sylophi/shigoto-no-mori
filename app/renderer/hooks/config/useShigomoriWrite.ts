import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ShigomoriConfig } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

interface WriteVariables {
  projectId: string;
  config: ShigomoriConfig;
}

export function useShigomoriWrite() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    mutationFn: async ({ projectId, config }: WriteVariables) => {
      await api.shigomori.write(projectId, config);
      return { projectId };
    },
    onSuccess: ({ projectId }) => {
      queryClient.invalidateQueries({
        queryKey: keys.shigomoriConfig(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: keys.projectLaunchers(projectId),
      });
    },
    meta: { errorTitle: "Couldn't save project config" },
  });
}
