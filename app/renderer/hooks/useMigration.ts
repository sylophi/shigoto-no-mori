// The v3 migration as this machine's shell serves it, from what its
// host tells it (packages/contracts/src/modules/migration.ts): read
// once, then kept as the shell pushes each change. Null until the host
// has said, once a window went on to the app past it, and on a client
// with no host of its own. Undefined while it is read.
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import { hasLocalHost } from "@/lib/localHost";
import { queryKeys } from "@/lib/queryKeys";

export function useMigration(): MigrationProgress | null | undefined {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!hasLocalHost) return;
    return window.api.migration.onChanged((progress) => {
      queryClient.setQueryData(queryKeys.migration(), progress);
    });
  }, [queryClient]);
  const { data } = useQuery({
    queryKey: queryKeys.migration(),
    queryFn: () => window.api.migration.read(),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: hasLocalHost,
  });
  return hasLocalHost ? data : null;
}
