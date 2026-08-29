import { useQuery } from "@tanstack/react-query";
import type { TerrierReadiness } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useTerrierReadiness() {
  return useQuery<TerrierReadiness>({
    queryKey: queryKeys.terrierReadiness(),
    queryFn: () => window.api.terrier.readiness(),
    meta: { errorTitle: "Couldn't check the terrier integration" },
  });
}
