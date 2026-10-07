// The worktree's port list off the scoped host (shared/ipc/modules/
// ports.ts): port-pool's allocation plus the user-added entries, each
// with a loopback liveness probe. Polled while mounted so a dev server
// starting or stopping on the host shows up on its own. The interval is
// the whole cost, since the host read is one small file plus a handful
// of instant loopback dials. The mounts are the worktree page's Ports
// section, the Ports dialog and the Live page's cards of worktrees
// running a script, so the timer lives as long as one of those is open.
// A worktree with no ports (or none read yet) has nothing to probe, so
// it polls slowly, enough to pick up a port-pool allocation or a peer
// that answers again. Adding a port refetches at once
// (useWorktreeDataWrite).
import { useQuery } from "@tanstack/react-query";
import type { WorktreePortsResult } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

const PORTS_POLL_MS = 5_000;
const EMPTY_POLL_MS = 20_000;

export function useWorktreePorts(worktree: { projectId: string; id: string }) {
  const { api, keys } = useHostScope();
  return useQuery<WorktreePortsResult>({
    queryKey: keys.worktreePorts(worktree.projectId, worktree.id),
    queryFn: () => api.ports.list(worktree.projectId, worktree.id),
    refetchInterval: (query) =>
      query.state.data?.ports.length ? PORTS_POLL_MS : EMPTY_POLL_MS,
    // An unreachable peer fails every poll: retrying three times per
    // tick would only stack noise on a failure the next tick repeats.
    retry: false,
    meta: { silentError: true },
  });
}
