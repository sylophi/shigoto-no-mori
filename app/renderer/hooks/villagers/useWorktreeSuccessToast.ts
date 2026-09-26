import { useQueryClient } from "@tanstack/react-query";
import type { ExternalToast } from "sonner";
import type { Worktree } from "@shared/schemas";
import { toastVillagerSuccess } from "@/components/villagers/toasts";
import { speakersFor } from "@/lib/villagers/speakers";

// A success toast about one worktree, said by its villager when it has
// one (toastVillagerSuccess), under this window's Village life,
// whichever device the worktree lives on. The toast waits only for the
// reads that find the speaker, which the cache usually holds already,
// and shows plain if they fail.
export function useWorktreeSuccessToast() {
  const queryClient = useQueryClient();
  return (
    worktree: Pick<Worktree, "id" | "name">,
    message: string,
    options?: ExternalToast,
  ): void => {
    void speakersFor(queryClient, [worktree]).then((speakers) =>
      toastVillagerSuccess(speakers.get(worktree.id), message, options),
    );
  };
}
