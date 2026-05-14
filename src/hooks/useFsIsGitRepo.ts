import { useQuery } from "@tanstack/react-query";

export function useFsIsGitRepo(path: string, enabled = true) {
  return useQuery<boolean>({
    queryKey: ["fs", "isGitRepo", path],
    queryFn: () => window.api.fs.isGitRepo(path),
    enabled: enabled && path.length > 0,
    staleTime: 5_000,
  });
}
