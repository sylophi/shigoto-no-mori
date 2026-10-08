import { useQuery } from "@tanstack/react-query";
import type { TerrierReadiness } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useTerrierReadiness({ enabled = true } = {}) {
  const { api, keys } = useHostScope();
  return useQuery<TerrierReadiness>({
    queryKey: keys.terrierReadiness(),
    queryFn: () => api.terrier.readiness(),
    enabled,
    meta: { errorTitle: "Couldn't check the terrier integration" },
  });
}
