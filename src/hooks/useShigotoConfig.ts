import { useQuery } from "@tanstack/react-query";
import type { ShigotoConfig } from "@shared/schemas";

export function useShigotoConfig(projectId: string | null) {
  return useQuery<ShigotoConfig | null>({
    queryKey: ["shigoto", projectId],
    queryFn: () => {
      if (!projectId) return null;
      return window.api.shigoto.read(projectId);
    },
    enabled: projectId !== null,
    staleTime: 30_000,
  });
}
