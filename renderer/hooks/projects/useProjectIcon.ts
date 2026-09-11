import { useQuery } from "@tanstack/react-query";
import type { ProjectIcon } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// `null` is the success case for icon-less projects, not an error, so
// React Query holds it for the session without retrying.
export function useProjectIcon(projectId: string): string | null {
  const { data } = useQuery<ProjectIcon | null>({
    queryKey: queryKeys.projectIcon(projectId),
    queryFn: () => window.api.projects.icon(projectId),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    meta: { silentError: true },
  });
  return data ? `data:${data.mime};base64,${data.base64}` : null;
}
