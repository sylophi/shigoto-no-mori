import { useQuery } from "@tanstack/react-query";
import type { TerrierReadiness } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useTerrierReadiness() {
  const { api, keys } = useHostScope();
  return useQuery<TerrierReadiness>({
    queryKey: keys.terrierReadiness(),
    queryFn: () => api.terrier.readiness(),
    meta: { errorTitle: "Couldn't check the terrier integration" },
  });
}
