import { useQuery } from "@tanstack/react-query";
import type { ProjectIcon } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

// `null` is the success case for icon-less projects, not an error — let
// React Query hold it for the session without retrying.
export function useProjectIcon(projectId: string): string | null {
  const { api, keys } = useHostScope();
  const { data } = useQuery<ProjectIcon | null>({
    queryKey: keys.projectIcon(projectId),
    queryFn: () => api.projects.icon(projectId),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    meta: { silentError: true },
  });
  return data ? `data:${data.mime};base64,${data.base64}` : null;
}
