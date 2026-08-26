import { useQuery } from "@tanstack/react-query";
import { localDeviceId } from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";

// Does the CALLING device hold command access on the scoped host? Drives
// whether the remote forest renders mutation controls (v2 step 6). The
// local device is always granted by contract, so it short-circuits with
// no IPC. A remote device answers via the per-caller remoteAccess
// preflight, cached under its own host key. A refused verdict is a
// normal read-only state, not an error to toast — the UI reads `granted`
// and renders a read-only note instead.
export function useCommandAccess(): { granted: boolean; isLoading: boolean } {
  const { deviceId, api, keys } = useHostScope();
  const isLocal = deviceId === localDeviceId;
  const query = useQuery({
    queryKey: keys.commandAccess(),
    queryFn: () => api.remoteAccess.commandAccess(),
    enabled: !isLocal,
    meta: { silentError: true },
  });
  if (isLocal) return { granted: true, isLoading: false };
  return { granted: query.data?.granted ?? false, isLoading: query.isPending };
}
