import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ShigomoriConfig } from "@shared/schemas";

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
      queryClient.invalidateQueries({ queryKey: ["shigomori", projectId] });
      queryClient.invalidateQueries({ queryKey: ["launchers", projectId] });
    },
    meta: { errorTitle: "Couldn't save project config" },
  });
}
