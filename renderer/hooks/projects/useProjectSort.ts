import { useQuery } from "@tanstack/react-query";
import type { ProjectSortMode } from "@shared/schemas";
import { useOptimisticPreference } from "@/hooks/ui/useOptimisticPreference";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useProjectSort() {
  const { api, keys } = useHostScope();
  return useQuery<ProjectSortMode>({
    queryKey: keys.projectsSort(),
    queryFn: () => api.projects.getSort(),
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
