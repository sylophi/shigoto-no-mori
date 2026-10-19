import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectSettingsPatch } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

interface PatchVariables {
  projectId: string;
  patch: ProjectSettingsPatch;
}

// Saves the project settings a form changed, each set or removed (null),
// so what the terminal or another device changed meanwhile stays.
export function useShigomoriPatch() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation({
    mutationFn: async ({ projectId, patch }: PatchVariables) => {
      await api.run(api.shigomori.patch({ projectId, patch }));
      return { projectId };
    },
    // The config's read is returned, so a save answers once it is in.
    onSuccess: ({ projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: keys.projectLaunchers(projectId),
      });
      return queryClient.invalidateQueries({
        queryKey: keys.shigomoriConfig(projectId),
      });
    },
    meta: { errorTitle: "Couldn't save project config" },
  });
}
