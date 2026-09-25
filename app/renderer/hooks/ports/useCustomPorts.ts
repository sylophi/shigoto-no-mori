// Add, edit and remove a worktree's user-added ports. They live in the
// worktree data file beside the notes, and useWorktreeDataWrite merges each
// edit over the stored document. Uniqueness by number is this layer's
// rule (PortForm refuses a duplicate up front so the user hears why,
// but the list is what must never hold two rows on one number).
import type { CustomPort } from "@shared/schemas";
import { useWorktreeDataWrite } from "@/hooks/worktrees/useWorktreeData";

export function useCustomPortsWrite(worktree: {
  projectId: string;
  id: string;
}) {
  const write = useWorktreeDataWrite();
  const variables = (change: (current: CustomPort[]) => CustomPort[]) => ({
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    patch: (current: { ports?: CustomPort[] }) => {
      const ports = change(current.ports ?? []);
      return { ports: ports.length > 0 ? ports : undefined };
    },
  });
  return {
    // add and update are awaited by the form, which shows the failure
    // in place. Remove has no form, so its failure is the global toast.
    add: (entry: CustomPort) =>
      write.mutateAsync(
        variables((current) => [
          ...current.filter((existing) => existing.port !== entry.port),
          entry,
        ]),
      ),
    // Replaces the entry at `port` in place. Its number may change, in
    // which case any other entry already on the new number gives way.
    update: (port: number, next: CustomPort) =>
      write.mutateAsync(
        variables((current) =>
          current
            .map((existing) => (existing.port === port ? next : existing))
            .filter(
              (existing) => existing === next || existing.port !== next.port,
            ),
        ),
      ),
    remove: (port: number) =>
      write.mutate(
        variables((current) =>
          current.filter((existing) => existing.port !== port),
        ),
      ),
  };
}
