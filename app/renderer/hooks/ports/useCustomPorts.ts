// Add, edit and remove a worktree's user-added ports, each by its number
// (useWorktreePortsPatch), so one changed elsewhere meanwhile stays. One
// entry a number is the engine's rule (PortFormView refuses a duplicate
// up front so the user hears why).
import type { CustomPort } from "@shigomori/contracts/schemas";
import { useWorktreePortsPatch } from "@/hooks/worktrees/useWorktreeData";

export function useCustomPortsWrite(worktree: {
  projectId: string;
  id: string;
}) {
  const patch = useWorktreePortsPatch();
  const target = { projectId: worktree.projectId, worktreeId: worktree.id };
  return {
    // add and update are awaited by the form, which shows the failure
    // in place. Remove has no form, so its failure is the global toast.
    add: (entry: CustomPort) => patch.mutateAsync({ ...target, put: [entry] }),
    // Its number may change, and then any other entry already on the new
    // number gives way.
    update: (port: number, next: CustomPort) =>
      patch.mutateAsync({ ...target, remove: [port], put: [next] }),
    remove: (port: number) => patch.mutate({ ...target, remove: [port] }),
  };
}
