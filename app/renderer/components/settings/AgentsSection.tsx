import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";
import type { AgentHarnessStatus } from "@shigomori/contracts/schemas";
import { AgentsSectionView } from "@shigomori/ui/views/settings/AgentsSectionView.tsx";

// The agent hooks section (AgentsSectionView), installed and removed
// through the scoped device right away.
export function AgentsSection() {
  const { api, keys, remote } = useHostScope();
  const queryClient = useQueryClient();
  const { data: harnesses } = useQuery<readonly AgentHarnessStatus[]>({
    queryKey: keys.agents(),
    queryFn: () => api.agents.status(),
    meta: gatedHostReadMeta(remote, "Couldn't check the agent hooks"),
  });
  const applyStatus = (next: readonly AgentHarnessStatus[]) => {
    queryClient.setQueryData(keys.agents(), next);
  };
  const setHooks = useMutation({
    mutationFn: (input: { harness: string; install: boolean }) =>
      api.agents.setHooks(input),
    onSuccess: applyStatus,
    meta: { errorTitle: "Couldn't change the hooks" },
  });
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  if (!harnesses) return null;

  return (
    <AgentsSectionView
      harnesses={harnesses}
      home={home}
      busy={setHooks.isPending}
      onSetHooks={(harness, install) => setHooks.mutate({ harness, install })}
    />
  );
}
