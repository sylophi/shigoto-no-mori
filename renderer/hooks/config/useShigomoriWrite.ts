import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ShigomoriConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

interface WriteVariables {
  projectId: string;
  config: ShigomoriConfig;
}

export function useShigomoriWrite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, config }: WriteVariables) => {
      await window.api.shigomori.write(projectId, config);
      return { projectId };
    },
    onSuccess: ({ projectId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.shigomoriConfig(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectLaunchers(projectId),
      });
    },
    meta: { errorTitle: "Couldn't save project config" },
  });
}
