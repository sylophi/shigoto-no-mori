import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { CarryOverStat } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Where each configured carry-over path exists, across checkouts. One
// query for the whole list. Rows read their own path out of it.
export function useCarryOverStats(projectId: string, paths: string[]) {
  const sorted = [...new Set(paths)].toSorted();
  return useQuery<Record<string, CarryOverStat>>({
    queryKey: queryKeys.carryOverStats(projectId, sorted),
    queryFn: () =>
      window.api.projects.carryOverStats({ projectId, paths: sorted }),
    enabled: sorted.length > 0,
    // Adding or removing an entry changes the key. Keep the other rows'
    // badges up while the new set loads.
    placeholderData: keepPreviousData,
    // Inline warning chip + icon resolution render their own state.
    meta: { silentError: true },
  });
}
