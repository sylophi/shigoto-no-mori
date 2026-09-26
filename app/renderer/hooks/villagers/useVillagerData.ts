import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VillagerDataStatus } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// How often the status is read again while a download runs, for its
// progress. Nothing else moves it on its own.
const DOWNLOADING_POLL_MS = 500;

// The villager data of the device the surrounding HostScope names
// (host/lib/villagers.ts): absent, downloading, ready or failed.
// Silent on error, so a peer build without the channel just shows no
// control.
export function useVillagerDataStatus({ enabled = true } = {}) {
  const { api, keys, hasHost } = useHostScope();
  return useQuery<VillagerDataStatus>({
    queryKey: keys.villagerData(),
    queryFn: () => api.villagers.status(),
    enabled: enabled && hasHost,
    refetchInterval: (query) =>
      query.state.data?.kind === "downloading" ? DOWNLOADING_POLL_MS : false,
    meta: { silentError: true },
  });
}

// The status and the three commands, for the Settings control. Each
// command answers with the new status, which lands in the cache as is.
export function useVillagerData() {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  const { data: status } = useVillagerDataStatus();
  const apply = (next: VillagerDataStatus) =>
    queryClient.setQueryData(keys.villagerData(), next);

  const download = useMutation({
    mutationFn: () => api.villagers.download(),
    onSuccess: apply,
    meta: { errorTitle: "Couldn't start the download" },
  });
  const cancel = useMutation({
    mutationFn: () => api.villagers.cancel(),
    onSuccess: apply,
    meta: { errorTitle: "Couldn't cancel the download" },
  });
  const remove = useMutation({
    mutationFn: () => api.villagers.remove(),
    onSuccess: apply,
    meta: { errorTitle: "Couldn't remove the villager data" },
  });
  return { status, download, cancel, remove };
}
