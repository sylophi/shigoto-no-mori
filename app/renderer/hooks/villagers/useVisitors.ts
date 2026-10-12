import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isQuiet } from "@/lib/villagers/moves";
import {
  recordCachedVisits,
  useVisitLog,
  useVisitsSince,
} from "@/lib/villagers/visitLog";
import { tallyVisits } from "@shigomori/ui/lib/villagers/visitors.ts";
import { useApi } from "@/lib/runtime/pageApi";

// Who has visited, by villager, from the visit log this app keeps
// (lib/villagers/visitLog.ts). Opening the album first records every
// worktree list the window already holds, so turning Village life on
// fills it from the residents straight away.
export function useVisitors() {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(() => {
    void recordCachedVisits(api, queryClient, isQuiet);
  }, [api, queryClient]);
  return tallyVisits(useVisitLog(), useVisitsSince());
}
