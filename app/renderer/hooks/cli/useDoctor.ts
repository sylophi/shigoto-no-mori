import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { DoctorReport } from "@shared/ipc/modules/cli";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateHostDevice } from "@/lib/queryKeys";

// The scoped device's `sm doctor` report. A full check spawns git and
// gh on the host, so it runs only when asked: `run` re-runs it on every
// mount (the health check dialog opening), and without it the hook
// reads whatever the last run left in the cache. Never on focus or a
// ping. Nor while a repair runs, whose own report lands in the cache
// when it is done. Errors stay silent in the toast layer: the dialog
// says them.
export function useDoctorReport({ run }: { run: boolean }) {
  const { api, keys } = useHostScope();
  const repairing = useDoctorRepairing();
  return useQuery<DoctorReport>({
    queryKey: keys.doctor(),
    queryFn: () => api.cli.doctor(),
    enabled: run && !repairing,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
    meta: { silentError: true },
  });
}

// `sm doctor --fix --yes`: the report after the repairs, seeded into
// the cache. Keyed, so a dialog reopened while one runs sees it
// (useDoctorRepairing) and neither re-reads nor repairs again.
export function useDoctorRepair() {
  const { api, keys, deviceId, remote } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: keys.doctor(),
    mutationFn: () => api.cli.doctorFix(),
    onSuccess: (report) => {
      queryClient.setQueryData(keys.doctor(), report);
      // An unregistered project or a pruned worktree is forest state. A
      // peer's own change ping covers a remote scope.
      if (!remote) invalidateHostDevice(queryClient, deviceId);
    },
    meta: { silentError: true },
  });
}

export function useDoctorRepairing(): boolean {
  const { keys } = useHostScope();
  return useIsMutating({ mutationKey: keys.doctor() }) > 0;
}
