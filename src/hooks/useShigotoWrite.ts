import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ShigotoConfig } from "@shared/schemas";

interface WriteVariables {
  projectId: string;
  config: ShigotoConfig;
}

export function useShigotoWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, config }: WriteVariables) => {
      await window.api.shigoto.write(projectId, config);
      return { projectId };
    },
    onSuccess: ({ projectId }) => {
      qc.invalidateQueries({ queryKey: ["shigoto", projectId] });
      qc.invalidateQueries({ queryKey: ["launchers", projectId] });
    },
    meta: { errorTitle: "Couldn't save project config" },
  });
}
