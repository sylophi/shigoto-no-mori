import { useQueryClient } from "@tanstack/react-query";
import type { ExternalToast } from "sonner";
import type { Worktree } from "@shared/schemas";
import { type HostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { toastVillagerSuccess } from "@/components/villagers/toasts";
import { speakersFor } from "@/lib/villagers/speakers";

// A success toast about one worktree, said by its villager when it has
// one (toastVillagerSuccess), under the Village life of the device the
// surrounding HostScope names: the one the worktree lives on (`on`
// names another, for a flow that lands a worktree elsewhere). The toast
// waits only for the reads that find the speaker, which the cache
// usually holds already, and shows plain if they fail.
export function useWorktreeSuccessToast(on?: HostScope) {
  const queryClient = useQueryClient();
  const current = useHostScope();
  const scope = on ?? current;
  return (
    worktree: Pick<Worktree, "id" | "name">,
    message: string,
    options?: ExternalToast,
  ): void => {
    void speakersFor(queryClient, scope, [worktree]).then((speakers) =>
      toastVillagerSuccess(speakers.get(worktree.id), message, options),
    );
  };
}
