// The worktree's port list off the scoped host (shared/ipc/modules/
// ports.ts): port-pool's allocation plus the user-added entries, each
// with a loopback liveness probe. Polled while mounted so a dev server
// starting or stopping on the host shows up on its own. The interval is
// the whole cost, since the host read is one small file plus a handful
// of instant loopback dials, and the only mount is the Ports dialog,
// so the timer lives as long as the dialog is open.
import { useQuery } from "@tanstack/react-query";
import type { WorktreePortsResult } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

const PORTS_POLL_MS = 5_000;

export function useWorktreePorts(worktree: { projectId: string; id: string }) {
  const { api, keys } = useHostScope();
  return useQuery<WorktreePortsResult>({
    queryKey: keys.worktreePorts(worktree.projectId, worktree.id),
    queryFn: () => api.ports.list(worktree.projectId, worktree.id),
    refetchInterval: PORTS_POLL_MS,
    // An unreachable peer fails every poll: retrying three times per
    // tick would only stack noise on a failure the next tick repeats.
    retry: false,
    meta: { silentError: true },
  });
}
