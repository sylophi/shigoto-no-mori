import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { VillagerDataStatus } from "@shigomori/contracts/schemas";
import { useHasLocalHost } from "@/lib/localHost";
import { queryKeysFor } from "@/lib/queryKeys";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";

// How often the status is read again while a download runs, for its
// progress. Nothing else moves it on its own.
const DOWNLOADING_POLL_MS = 500;

// This device's villager data (host/lib/VillagerData.ts): absent,
// downloading, ready or failed. Never asked on a web client, which has
// no device of its own and offers no Village life.
export function useVillagerDataStatus({ enabled = true } = {}) {
  const hasLocalHost = useHasLocalHost();
  return useQuery({
    ...villagerDataStatusQueryOptions(useApi()),
    enabled: enabled && hasLocalHost,
    refetchInterval: (query) =>
      query.state.data?.kind === "downloading" ? DOWNLOADING_POLL_MS : false,
  });
}

// The read itself, shared with callers outside React.
export function villagerDataStatusQueryOptions(api: RendererApi) {
  return queryOptions<VillagerDataStatus>({
    queryKey: queryKeysFor(api.deviceId).villagerData(),
    queryFn: () => api.villagers.status(),
    meta: { silentError: true },
  });
}

// The status and the three commands, for the Settings control. Each
// command answers with the new status, which lands in the cache as is.
export function useVillagerData() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: status } = useVillagerDataStatus();
  const apply = (next: VillagerDataStatus) =>
    queryClient.setQueryData(queryKeysFor(api.deviceId).villagerData(), next);

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
