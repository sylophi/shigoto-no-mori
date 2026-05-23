import { useQuery } from "@tanstack/react-query";
import type { ShigomoriConfig } from "@shared/schemas";

export function useShigomoriConfig(projectId: string | null) {
  return useQuery<ShigomoriConfig | null>({
    queryKey: ["shigomori", projectId],
    queryFn: () => {
      if (!projectId) return null;
      return window.api.shigomori.read(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't load project config" },
  });
}
