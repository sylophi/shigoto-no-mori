import { useQuery } from "@tanstack/react-query";
import type { ProjectSortMode } from "@shared/schemas";
import { useOptimisticPreference } from "@/hooks/ui/useOptimisticPreference";
import { queryKeys } from "@/lib/queryKeys";

export function useProjectSort() {
  return useQuery<ProjectSortMode>({
    queryKey: queryKeys.projectsSort(),
    queryFn: () => window.api.projects.getSort(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read project sort preference" },
  });
}

export function useSetProjectSort() {
  return useOptimisticPreference<ProjectSortMode>(
    queryKeys.projectsSort(),
    (mode) => window.api.projects.setSort(mode),
    "Couldn't save project sort preference",
  );
}
