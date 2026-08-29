import { useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";

export function useRuntimeInfo() {
  const { api, deviceId, keys } = useHostScope();
  return useQuery<RuntimeInfo>({
    queryKey: keys.runtimeInfo(),
    queryFn: () => api.runtime.info(),
    staleTime: Number.POSITIVE_INFINITY,
    // runtime is a local-only module (remote: false), so under a remote
    // scope this would only ever reject at the wire. Consumers already
    // treat missing data as "no homedir to abbreviate against".
    enabled: deviceId === localDeviceId,
    meta: { errorTitle: "Couldn't read runtime info" },
  });
}
