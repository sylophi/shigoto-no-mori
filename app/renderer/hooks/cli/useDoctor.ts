import { useEffect, useState } from "react";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { DoctorReport } from "@shared/ipc/modules/cli";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateHostDevice, type QueryKeyRegistry } from "@/lib/queryKeys";

// The app checks this machine on its own this often, the first time
// this long after launch (the boot has enough to do).
const WATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WATCH_FIRST_DELAY_MS = 60_000;

// Errors stay silent in the toast layer: the dialog says them, and a
// background run's failure is no news worth a toast.
function doctorQuery(api: HostApi, keys: QueryKeyRegistry) {
  return {
    queryKey: keys.doctor(),
    queryFn: () => api.cli.doctor(),
    meta: { silentError: true },
  };
}

// The scoped device's `sm doctor` report. A full check spawns git and
// gh on the host, so it runs only when asked: `run` re-runs it on every
// mount (the health check dialog opening), and without it the hook
// reads whatever the last run left in the cache (the dialog's, or
// useDoctorWatch's for this machine). Never on a ping. Nor while a
// repair runs, whose own report lands in the cache when it is done.
export function useDoctorReport({ run }: { run: boolean }) {
  const { api, keys } = useHostScope();
  const repairing = useDoctorRepairing();
  return useQuery<DoctorReport>({
    ...doctorQuery(api, keys),
    enabled: run && !repairing,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
  });
}

// Mounted once by the app shell, where the scope is this machine: its
// check on a timer, so Settings' health check has a recent verdict
// without anyone opening the dialog. A hostless client has no machine
// of its own to check, and a peer's check runs in that peer's own app.
export function useDoctorWatch(): void {
  const { api, keys, hasHost } = useHostScope();
  const repairing = useDoctorRepairing();
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setStarted(true),
      WATCH_FIRST_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);
  useQuery<DoctorReport>({
    ...doctorQuery(api, keys),
    enabled: hasHost && started && !repairing,
    staleTime: WATCH_INTERVAL_MS,
    refetchInterval: WATCH_INTERVAL_MS,
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
