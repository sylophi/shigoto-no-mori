import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { VillagerDataStatus } from "@shigomori/contracts/schemas";
import { hasLocalHost } from "@/lib/localHost";
import { queryKeys } from "@/lib/queryKeys";

// How often the status is read again while a download runs, for its
// progress. Nothing else moves it on its own.
const DOWNLOADING_POLL_MS = 500;

// This device's villager data (host/lib/villagers.ts): absent,
// downloading, ready or failed. Never asked on a web client, which has
// no device of its own and offers no Village life.
export function useVillagerDataStatus({ enabled = true } = {}) {
  return useQuery({
    ...villagerDataStatusQueryOptions(),
    enabled: enabled && hasLocalHost,
    refetchInterval: (query) =>
      query.state.data?.kind === "downloading" ? DOWNLOADING_POLL_MS : false,
  });
}

// The read itself, shared with callers outside React.
export function villagerDataStatusQueryOptions() {
  return queryOptions<VillagerDataStatus>({
    queryKey: queryKeys.villagerData(),
    queryFn: () => window.api.villagers.status(),
    meta: { silentError: true },
  });
}

// The status and the three commands, for the Settings control. Each
// command answers with the new status, which lands in the cache as is.
export function useVillagerData() {
  const queryClient = useQueryClient();
  const { data: status } = useVillagerDataStatus();
  const apply = (next: VillagerDataStatus) =>
    queryClient.setQueryData(queryKeys.villagerData(), next);

  const download = useMutation({
    mutationFn: () => window.api.villagers.download(),
    onSuccess: apply,
    meta: { errorTitle: "Couldn't start the download" },
  });
  const cancel = useMutation({
    mutationFn: () => window.api.villagers.cancel(),
    onSuccess: apply,
    meta: { errorTitle: "Couldn't cancel the download" },
  });
  const remove = useMutation({
    mutationFn: () => window.api.villagers.remove(),
    onSuccess: apply,
    meta: { errorTitle: "Couldn't remove the villager data" },
  });
  return { status, download, cancel, remove };
}
