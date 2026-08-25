import { useQuery } from "@tanstack/react-query";
import type { ShigomoriConfig } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useShigomoriConfig(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<ShigomoriConfig | null>({
    queryKey: keys.shigomoriConfig(projectId),
    queryFn: () => {
      if (!projectId) return null;
      return api.shigomori.read(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't load project config" },
  });
}
