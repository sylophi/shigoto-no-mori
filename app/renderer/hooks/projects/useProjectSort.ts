import { useQuery } from "@tanstack/react-query";
import type { ProjectSortMode } from "@shared/schemas";
import { useOptimisticPreference } from "@/hooks/ui/useOptimisticPreference";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { hasLocalHost } from "@/lib/localHost";

// A hostless client has no projects of its own to order, so it never
// asks: the tree it draws is the peers', which the merge orders.
export function useProjectSort() {
  const { api, keys } = useHostScope();
  return useQuery<ProjectSortMode>({
    queryKey: keys.projectsSort(),
    queryFn: () => api.projects.getSort(),
    enabled: hasLocalHost,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read project sort preference" },
  });
}

export function useSetProjectSort() {
  const { api, keys } = useHostScope();
  return useOptimisticPreference<ProjectSortMode>(
    keys.projectsSort(),
    (mode) => api.projects.setSort(mode),
    "Couldn't save project sort preference",
  );
}
